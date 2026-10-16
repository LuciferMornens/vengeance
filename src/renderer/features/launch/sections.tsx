import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Eye, EyeOff, Plus, RefreshCw, Search, ShieldOff, X } from 'lucide-react'
import type { EngineId } from '@shared/api/engine'
import type {
  EngineToolInfo,
  ExtensionFlagInfo,
  ExtensionFlagValue,
  LaunchOptions
} from '@shared/api/launch'
import { friendlyFlagName } from '@shared/display-names'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import { pluralize } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { samePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import { Button, Input, Skeleton, Switch, Textarea, Tooltip, toast } from '../../ui'
import { isMaskedEnvValue, looksSecret } from './options'
import { Group, Note, PathList, Row, TagInput, type TagSuggestion } from './parts'
import { launchFlagsKey, loadExtensionFlags, useLaunch } from './store'

/** The editor sections of the launch-options dialog; each edits one slice of a LaunchOptions draft. */

export interface SectionProps {
  draft: LaunchOptions
  patch(change: Partial<LaunchOptions>): void
  cwd: string
  engine: EngineId
}

/** Used until the engine help has been read (pi 1.1.0 built-in tool names). */
const FALLBACK_TOOLS: EngineToolInfo[] = [
  'read',
  'bash',
  'powershell',
  'edit',
  'write',
  'grep',
  'find',
  'ls'
].map((name) => ({ name, description: name }))
const EXTENSION_TOOLS: EngineToolInfo[] = [
  {
    name: 'codemode',
    description: 'Run JavaScript that calls the other tools (built-in extension)'
  },
  {
    name: 'tool_search',
    description: 'Search and declare tools that are not declared yet (built-in extension)'
  }
]

function useKnownTools(cwd: string, engine: EngineId): TagSuggestion[] {
  const flags = useLaunch((s) => s.flags[launchFlagsKey(cwd, engine)])
  const builtin =
    flags?.status === 'ready' && flags.result.builtinTools.length > 0
      ? flags.result.builtinTools
      : FALLBACK_TOOLS
  return [...builtin, ...EXTENSION_TOOLS].map((tool) => ({
    value: tool.name,
    description: tool.description
  }))
}

/** `--tools` cannot mix plain names with `+name`/`-name` entries (pi cli.md). */
function mixedToolList(tools: string[]): boolean {
  const deltas = tools.filter((t) => /^[+-]/.test(t)).length
  return deltas > 0 && deltas < tools.length
}

export function ToolsSection({ draft, patch, cwd, engine }: SectionProps) {
  const known = useKnownTools(cwd, engine)
  const tools = draft.tools ?? []
  return (
    <>
      <Group>
        <Row
          label="Disable all tools"
          description="Start with every built-in, extension and MCP tool off."
        >
          <Switch
            aria-label="Disable all tools"
            checked={!!draft.noTools}
            onCheckedChange={(v) => patch({ noTools: v })}
          />
        </Row>
        <Row
          label="Disable built-in tools"
          description="Keep extension and custom tools, drop read, bash, edit and the rest."
        >
          <Switch
            aria-label="Disable built-in tools"
            checked={!!draft.noBuiltinTools}
            onCheckedChange={(v) => patch({ noBuiltinTools: v })}
          />
        </Row>
      </Group>
      <Group
        title="Allow"
        description="Replaces the default selection. Use * patterns, or only +name / -name entries to adjust the defaults."
      >
        <div className="p-3">
          <TagInput
            aria-label="Allowed tools"
            values={tools}
            onChange={(v) => patch({ tools: v })}
            placeholder="read, grep, mcp__github__*"
            suggestions={known}
          />
          {mixedToolList(tools) && (
            <Note tone="warning" icon={<AlertTriangle />} className="mt-2.5">
              Plain names and +name / -name entries can’t be mixed. Use one style.
            </Note>
          )}
        </div>
      </Group>
      <Group title="Exclude" description="Applied after everything else, MCP tools included.">
        <div className="p-3">
          <TagInput
            aria-label="Excluded tools"
            values={draft.excludeTools ?? []}
            onChange={(v) => patch({ excludeTools: v })}
            placeholder="write, mcp__*"
            suggestions={known}
          />
        </div>
      </Group>
    </>
  )
}

export function ResourcesSection({ draft, patch, cwd }: SectionProps) {
  const toggles: Array<{
    key: 'noExtensions' | 'noSkills' | 'noPromptTemplates' | 'noContextFiles' | 'noMcp'
    label: string
    description: string
  }> = [
    {
      key: 'noExtensions',
      label: 'Extensions',
      description: 'Discovered, configured and built-in extensions.'
    },
    { key: 'noSkills', label: 'Skills', description: 'Discovered and configured skills.' },
    {
      key: 'noPromptTemplates',
      label: 'Prompt templates',
      description: 'Discovered and configured slash-command templates.'
    },
    {
      key: 'noContextFiles',
      label: 'Context files',
      description: 'AGENTS.md and CLAUDE.md from this folder and its parents.'
    },
    {
      key: 'noMcp',
      label: 'MCP servers',
      description: 'Built-in MCP support: servers, MCP tools and /mcp.'
    }
  ]
  return (
    <>
      <Group title="Load at startup">
        {toggles.map((t) => (
          <Row key={t.key} label={t.label} description={t.description}>
            <Switch
              aria-label={`Load ${t.label.toLowerCase()}`}
              checked={!draft[t.key]}
              onCheckedChange={(on) => patch({ [t.key]: !on })}
            />
          </Row>
        ))}
      </Group>
      <Group
        title="Extra extensions"
        description="Loaded even when discovery is off. Files, folders or builtin:name."
      >
        <div className="p-3">
          <PathList
            cwd={cwd}
            values={draft.extensions ?? []}
            onChange={(v) => patch({ extensions: v })}
            placeholder="./tools/review.ts or builtin:mcp"
            filters={[{ name: 'Extensions', extensions: ['ts', 'js', 'mjs'] }]}
          />
        </div>
      </Group>
      <Group title="Extra skills">
        <div className="p-3">
          <PathList
            cwd={cwd}
            values={draft.skills ?? []}
            onChange={(v) => patch({ skills: v })}
            placeholder="Skill file or folder"
            filters={[{ name: 'Skills', extensions: ['md'] }]}
          />
        </div>
      </Group>
      <Group title="Extra prompt templates">
        <div className="p-3">
          <PathList
            cwd={cwd}
            values={draft.promptTemplates ?? []}
            onChange={(v) => patch({ promptTemplates: v })}
            placeholder="Template file or folder"
            filters={[{ name: 'Templates', extensions: ['md'] }]}
          />
        </div>
      </Group>
    </>
  )
}

async function pickTextFile(cwd: string): Promise<string | null> {
  const [file] = await invoke('sys:pick-files', {
    defaultPath: cwd,
    multiple: false,
    filters: [{ name: 'Text', extensions: ['md', 'txt'] }]
  })
  return file ?? null
}

export function PromptSection({ draft, patch, cwd }: SectionProps) {
  const append = draft.appendSystemPrompt ?? []
  const setAppend = (index: number, value: string) =>
    patch({ appendSystemPrompt: append.map((v, i) => (i === index ? value : v)) })
  const addFile = async (apply: (path: string) => void) => {
    const file = await pickTextFile(cwd)
    if (file) apply(file)
  }
  return (
    <>
      <Group
        title="Replace"
        description="Text, or the path of a file. Replaces the engine’s default system prompt."
        actions={
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void addFile((path) => patch({ systemPrompt: path }))}
          >
            Use file…
          </Button>
        }
      >
        <div className="p-3">
          <Textarea
            aria-label="Replacement system prompt"
            value={draft.systemPrompt ?? ''}
            onChange={(e) => patch({ systemPrompt: e.target.value })}
            placeholder="Leave empty to keep the default system prompt"
            className={'min-h-24 bg-surface-2 font-mono text-xs'}
          />
        </div>
      </Group>
      <Group
        title="Append"
        description="Added after the system prompt, in order. Text or file paths."
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              leading={<Plus />}
              onClick={() => patch({ appendSystemPrompt: [...append, ''] })}
            >
              Text
            </Button>
            <Button
              size="xs"
              variant="ghost"
              leading={<Plus />}
              onClick={() =>
                void addFile((path) => patch({ appendSystemPrompt: [...append, path] }))
              }
            >
              File…
            </Button>
          </div>
        }
      >
        {append.length === 0 ? (
          <div className="px-3.5 py-3 text-sm text-fg-3">Nothing appended.</div>
        ) : (
          <div className="space-y-2 p-3">
            {append.map((value, index) => (
              <div key={index} className="flex items-start gap-2">
                <span className="tabular mt-2 w-4 shrink-0 text-right text-xs text-fg-3">
                  {index + 1}
                </span>
                <Textarea
                  aria-label={`Appended prompt ${index + 1}`}
                  value={value}
                  onChange={(e) => setAppend(index, e.target.value)}
                  placeholder="Instructions or a file path"
                  className={'min-h-14 flex-1 bg-surface-2 font-mono text-xs'}
                />
                <button
                  type="button"
                  aria-label={`Remove appended prompt ${index + 1}`}
                  onClick={() =>
                    patch({ appendSystemPrompt: append.filter((_, i) => i !== index) })
                  }
                  className="mt-1 flex size-7 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Group>
    </>
  )
}

/** Model ids offered by a running engine in this workspace, for the scope editor. */
function useWorkspaceModels(cwd: string, engine: EngineId): TagSuggestion[] {
  const agentId = useAgents((state) =>
    state.order.find((identifier) => {
      const agent = state.agents[identifier]
      return (
        agent?.info.engine === engine && samePath(agent.info.cwd, cwd) && agent.status === 'ready'
      )
    })
  )
  const [models, setModels] = useState<TagSuggestion[]>([])
  useEffect(() => {
    setModels([])
    if (!agentId) return
    let alive = true
    rpc(agentId, { type: 'get_available_models' })
      .then(
        ({ models: list }) =>
          alive &&
          setModels(
            list.slice(0, 12).map((m) => ({ value: `${m.provider}/${m.id}`, description: m.name }))
          )
      )
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [agentId])
  return models
}

export function ModelsSection({ draft, patch, cwd, engine }: SectionProps) {
  const suggestions = useWorkspaceModels(cwd, engine)
  return (
    <>
      <Group
        title="Model scope"
        description="Limits startup and model cycling. Exact ids, fuzzy names or globs, with an optional :thinking suffix."
      >
        <div className="p-3">
          <TagInput
            aria-label="Model scope"
            values={draft.models ?? []}
            onChange={(v) => patch({ models: v })}
            placeholder="anthropic/*, sonnet:high"
            suggestions={suggestions}
          />
        </div>
      </Group>
      <Group title="Network">
        <Row
          label="Offline"
          description="Turn off automatic network activity, including model catalog refreshes."
        >
          <Switch
            aria-label="Offline"
            checked={!!draft.offline}
            onCheckedChange={(v) => patch({ offline: v })}
          />
        </Row>
      </Group>
    </>
  )
}

/** `mask`: the masked saved value this row started with (restored when a cleared field is left empty). */
type EnvRow = { id: number; key: string; value: string; mask?: string }

export function EnvironmentSection({ draft, patch, cwd, engine }: SectionProps) {
  const [rows, setRows] = useState<EnvRow[]>(() =>
    Object.entries(draft.env ?? {}).map(([key, value], id) => ({
      id,
      key,
      value,
      mask: isMaskedEnvValue(value) ? value : undefined
    }))
  )
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set())
  const commit = (next: EnvRow[]) => {
    setRows(next)
    patch({
      env: Object.fromEntries(next.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]))
    })
  }
  const update = (id: number, change: Partial<EnvRow>) =>
    commit(rows.map((r) => (r.id === id ? { ...r, ...change } : r)))
  /** Local-only row change (the draft keeps the mask, so the stored value survives). */
  const setLocal = (id: number, change: Partial<EnvRow>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...change } : r)))
  const add = () =>
    setRows([...rows, { id: Math.max(-1, ...rows.map((r) => r.id)) + 1, key: '', value: '' }])
  const toggle = async (row: EnvRow) => {
    if (revealed.has(row.id)) {
      setRevealed((s) => {
        const next = new Set(s)
        next.delete(row.id)
        return next
      })
      return
    }
    if (isMaskedEnvValue(row.value)) {
      try {
        const clear = await invoke('engine:reveal-env', engine, cwd, row.key.trim())
        if (clear === null) {
          toast({
            level: 'info',
            title: 'Saved value is unavailable',
            description: 'Enter a new value for this variable.'
          })
          return
        }
        setLocal(row.id, { value: clear })
      } catch (error) {
        toast({
          level: 'error',
          title: 'Could not reveal this variable',
          description: error instanceof Error ? error.message : String(error)
        })
        return
      }
    }
    setRevealed((s) => new Set(s).add(row.id))
  }
  const keys = rows.map((r) => r.key.trim()).filter(Boolean)
  const duplicate = keys.find((k, i) => keys.indexOf(k) !== i)
  return (
    <Group
      title="Environment variables"
      description="Set for this engine process, over the app’s own environment. Stored encrypted on this device."
      actions={
        <Button size="xs" variant="ghost" leading={<Plus />} onClick={add}>
          Variable
        </Button>
      }
    >
      {rows.length === 0 ? (
        <div className="px-3.5 py-3 text-sm text-fg-3">
          No variables. Add provider keys, proxy settings or engine options.
        </div>
      ) : (
        <div className="space-y-1.5 p-3">
          {rows.map((row) => {
            const masked = isMaskedEnvValue(row.value)
            const secret = !!row.mask || masked || looksSecret(row.key, row.value)
            const show = !secret || revealed.has(row.id)
            return (
              <div key={row.id} className="flex items-center gap-1.5">
                <Input
                  inputSize="sm"
                  aria-label="Variable name"
                  value={row.key}
                  placeholder="NAME"
                  spellCheck={false}
                  onChange={(e) => update(row.id, { key: e.target.value.replace(/\s/g, '') })}
                  className={'w-[200px] shrink-0 font-mono text-xs'}
                />
                <span className="text-fg-4">=</span>
                <Input
                  inputSize="sm"
                  aria-label={`Value of ${row.key || 'variable'}`}
                  type={show && !masked ? 'text' : 'password'}
                  value={row.value}
                  placeholder={row.mask ? 'Type a new value' : 'value'}
                  spellCheck={false}
                  // Editing part of a mask would save the mask literally: start from an empty field instead.
                  onFocus={() => masked && setLocal(row.id, { value: '' })}
                  onBlur={() =>
                    row.mask && row.value === '' && setLocal(row.id, { value: row.mask })
                  }
                  onChange={(e) => update(row.id, { value: e.target.value })}
                  className={'min-w-0 flex-1 font-mono text-xs'}
                  trailing={
                    secret ? (
                      <Tooltip content={show ? 'Hide value' : 'Show value'}>
                        <button
                          type="button"
                          aria-label={show ? 'Hide value' : 'Show value'}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void toggle(row)}
                          className="flex size-5 items-center justify-center rounded-xs text-fg-3 hover:text-fg"
                        >
                          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                        </button>
                      </Tooltip>
                    ) : undefined
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove ${row.key || 'variable'}`}
                  onClick={() => commit(rows.filter((r) => r.id !== row.id))}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )
          })}
          {duplicate && (
            <Note tone="warning" icon={<AlertTriangle />} className="pt-1">
              {duplicate} is set twice; the last value wins.
            </Note>
          )}
        </div>
      )}
    </Group>
  )
}

/** Repeated values (set outside this editor) show the last one, which is what the engine uses. */
function flagText(value: ExtensionFlagValue | undefined): string {
  if (Array.isArray(value)) return value.at(-1) ?? ''
  return typeof value === 'string' ? value : ''
}

function FlagControl({
  flag,
  value,
  onChange
}: {
  flag: ExtensionFlagInfo
  value: ExtensionFlagValue | undefined
  onChange(value: ExtensionFlagValue | undefined): void
}) {
  const label = friendlyFlagName(flag.name)
  if (flag.takesValue) {
    return (
      <Input
        inputSize="sm"
        aria-label={label}
        value={flagText(value)}
        placeholder="value"
        onChange={(e) => onChange(e.target.value || undefined)}
        className={'w-[200px] font-mono text-xs'}
      />
    )
  }
  return (
    <Switch
      aria-label={label}
      checked={value === true}
      onCheckedChange={(on) => onChange(on || undefined)}
    />
  )
}

/** Human title of an extension flag with the raw flag as quiet secondary text. */
function FlagLabel({ name }: { name: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{friendlyFlagName(name)}</span>
      <span className="shrink-0 font-mono text-2xs font-normal text-fg-3">--{name}</span>
    </span>
  )
}

export function FlagsSection({ draft, patch, cwd, engine }: SectionProps) {
  const state = useLaunch((s) => s.flags[launchFlagsKey(cwd, engine)])
  const [query, setQuery] = useState('')
  const values = draft.extensionFlags ?? {}
  const setFlag = (name: string, value: ExtensionFlagValue | undefined) => {
    const next = { ...values }
    if (value === undefined) delete next[name]
    else next[name] = value
    patch({ extensionFlags: next })
  }

  const flags = state?.status === 'ready' ? state.result.flags : []
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<
      string,
      { label: string; technical: string | null; flags: ExtensionFlagInfo[] }
    >()
    for (const flag of flags) {
      if (
        q &&
        !flag.name.includes(q) &&
        !friendlyFlagName(flag.name).toLowerCase().includes(q) &&
        !flag.description.toLowerCase().includes(q)
      )
        continue
      const key = flag.group ?? ''
      const group = map.get(key) ?? {
        label: flag.groupLabel ?? 'Other extensions',
        technical: flag.group,
        flags: []
      }
      group.flags.push(flag)
      map.set(key, group)
    }
    return [...map.entries()]
  }, [flags, query])
  const unknown =
    state?.status === 'ready'
      ? Object.keys(values).filter((name) => !flags.some((f) => f.name === name))
      : []
  const extensionCount = new Set(flags.map((f) => f.group ?? '')).size

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        {flags.length > 8 && (
          <Input
            inputSize="sm"
            aria-label="Filter extension flags"
            leading={<Search />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${flags.length} flags`}
            className={'w-[240px]'}
          />
        )}
        <div className="min-w-0 flex-1 truncate text-xs text-fg-3">
          {state?.status === 'ready' &&
            (flags.length > 0
              ? `${pluralize(flags.length, 'flag')} from ${pluralize(extensionCount, 'extension')} · Engine ${state.result.engineVersion}`
              : `Engine ${state.result.engineVersion}`)}
          {state?.status === 'loading' && 'Asking the engine for extension flags…'}
        </div>
        <Button
          size="xs"
          variant="ghost"
          leading={<RefreshCw className={cn(state?.status === 'loading' && 'animate-spin')} />}
          disabled={state?.status === 'loading'}
          onClick={() => void loadExtensionFlags(cwd, engine, true)}
        >
          Refresh
        </Button>
      </div>

      {state?.status === 'ready' && !state.result.trusted && (
        <Note
          icon={<ShieldOff />}
          className="mb-4 rounded-md bg-surface-1 px-3 py-2 shadow-[inset_0_0_0_1px_var(--hairline-soft)]"
        >
          This folder isn’t trusted, so flags from project extensions aren’t listed.
        </Note>
      )}

      {(!state || state.status === 'loading') && (
        <Group>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-5 border-b border-hairline-soft px-3.5 py-3 last:border-b-0"
            >
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-3/4" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ))}
        </Group>
      )}

      {state?.status === 'error' && (
        <Group>
          <div className="flex items-start gap-3 px-3.5 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <div className="text-ui font-medium text-fg">Couldn’t read extension flags</div>
              <div className="mt-0.5 text-sm break-words text-fg-3">{state.message}</div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void loadExtensionFlags(cwd, engine, true)}
            >
              Try again
            </Button>
          </div>
        </Group>
      )}

      {state?.status === 'ready' && flags.length === 0 && (
        <Group>
          <div className="px-3.5 py-3 text-sm text-fg-3">
            No installed extension registers command-line flags.
          </div>
        </Group>
      )}

      {groups.map(([key, group]) => (
        <Group
          key={key}
          title={<span title={group.technical ?? undefined}>{group.label}</span>}
          actions={<span className="tabular text-xs text-fg-3">{group.flags.length}</span>}
        >
          {group.flags.map((flag) => (
            <Row
              key={flag.name}
              label={<FlagLabel name={flag.name} />}
              description={
                <span className="line-clamp-2" title={flag.description}>
                  {flag.description}
                </span>
              }
            >
              <FlagControl
                flag={flag}
                value={values[flag.name]}
                onChange={(v) => setFlag(flag.name, v)}
              />
            </Row>
          ))}
        </Group>
      ))}

      {unknown.length > 0 && (
        <Group
          title="Not offered by the engine"
          description="Saved flags that no loaded extension registers. The engine ignores them."
        >
          {unknown.map((name) => (
            <Row key={name} label={<FlagLabel name={name} />}>
              <Button size="xs" variant="ghost" onClick={() => setFlag(name, undefined)}>
                Remove
              </Button>
            </Row>
          ))}
        </Group>
      )}
    </>
  )
}
