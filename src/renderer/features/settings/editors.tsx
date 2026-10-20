import { useMemo, type ReactNode } from 'react'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import type { JsonObject, JsonValue, ModelInfo } from '@shared/api/settings'
import { THINKING_LEVEL_OPTIONS } from '@shared/api/settings-schema'
import { cn } from '../../lib/cn'
import { platform } from '../../lib/ipc'
import { Badge, Button, IconButton, SegmentedControl, Select } from '../../ui'
import { ListEditor, NumberField } from './controls'
import { modelKey, ModelLabel, ModelPicker, useCatalog } from './model-picker'
import { SIGN_IN_EXPIRED, signInExpired } from './provider-status'
import { activeCwd, useResolved, useSettings, type ResolvedSetting } from './store'

/** Rich editors for structured settings (models, per-model maps, tool selection). */

function asObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asStrings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
}

function useModelLookup() {
  const { catalog } = useCatalog()
  return useMemo(() => new Map((catalog?.models ?? []).map((m) => [modelKey(m), m])), [catalog])
}

// ─── Default model ─────────────────────────────────────────────────────────

export function DefaultModelEditor({ disabled }: { disabled: boolean }) {
  const provider = useResolved('defaultProvider').value
  const model = useResolved('defaultModel').value
  const setForTarget = useSettings((s) => s.setForTarget)
  const value =
    typeof provider === 'string' && typeof model === 'string'
      ? `${provider}/${model}`
      : typeof model === 'string'
        ? model
        : undefined
  const lookup = useModelLookup()
  const selected = value ? lookup.get(value) : undefined
  const selectedProvider = useSettings((s) =>
    s.catalog?.providers.find((p) => p.id === selected?.provider)
  )
  const choose = async (m: ModelInfo) => {
    const { engine, scope } = useSettings.getState()
    const target = { engine, scope, cwd: activeCwd() }
    await setForTarget(target, 'defaultProvider', m.provider)
    await setForTarget(target, 'defaultModel', m.id)
  }
  return (
    <div className="flex items-center gap-2">
      <ModelPicker
        value={value}
        onSelect={(m) => void choose(m)}
        placeholder="Automatic — best available model"
        disabled={disabled}
        className="flex-1"
      />
      {selected && !selected.available && (
        <Badge tone="warning">
          {selectedProvider && signInExpired(selectedProvider)
            ? SIGN_IN_EXPIRED.label
            : 'Needs sign-in'}
        </Badge>
      )}
    </div>
  )
}

// ─── Per-model thinking levels ─────────────────────────────────────────────

function EntryShell({
  model,
  fallback,
  inherited,
  children,
  onRemove
}: {
  model?: ModelInfo
  fallback: string
  inherited?: boolean
  children: ReactNode
  onRemove?: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md px-2.5 py-1.5 hover:bg-hover',
        inherited && 'opacity-60'
      )}
    >
      <ModelLabel model={model} fallback={fallback} className="min-w-0 flex-1" />
      {inherited && <Badge>Inherited</Badge>}
      {children}
      {onRemove ? (
        <IconButton label="Remove" size="xs" onClick={onRemove}>
          <Trash2 />
        </IconButton>
      ) : (
        <span className="size-6" />
      )}
    </div>
  )
}

function inheritedEntries(resolved: ResolvedSetting, scope: string): JsonObject {
  return scope === 'project' ? asObject(resolved.globalValue) : {}
}

export function ModelThinkingLevelsEditor({
  resolved,
  disabled
}: {
  resolved: ResolvedSetting
  disabled: boolean
}) {
  const scope = useSettings((s) => s.scope)
  const set = useSettings((s) => s.set)
  const lookup = useModelLookup()
  const own = asObject(resolved.setHere ? resolved.value : undefined)
  const inherited = inheritedEntries(resolved, scope)
  const keys = [...new Set([...Object.keys(own), ...Object.keys(inherited)])]
  const levelsFor = (key: string) => {
    const supported = lookup.get(key)?.thinkingLevels
    return THINKING_LEVEL_OPTIONS.filter((o) => !supported || supported.includes(o.value as never))
  }
  return (
    <div
      className={cn(
        'rounded-card bg-surface-1 p-1 shadow-[inset_0_0_0_1px_var(--hairline)]',
        disabled && 'pointer-events-none'
      )}
    >
      {keys.length === 0 && (
        <div className="px-3 py-2.5 text-sm text-fg-3">
          No per-model levels. New sessions use the default thinking level.
        </div>
      )}
      {keys.map((key) => {
        const isOwn = key in own
        const level = (isOwn ? own[key] : inherited[key]) as string
        return (
          <EntryShell
            key={key}
            model={lookup.get(key)}
            fallback={key}
            inherited={!isOwn}
            onRemove={isOwn ? () => void set(['modelThinkingLevels', key], undefined) : undefined}
          >
            <Select
              size="sm"
              className="w-[132px]"
              value={level}
              onValueChange={(next) => void set(['modelThinkingLevels', key], next)}
              options={levelsFor(key).map((o) => ({ value: String(o.value), label: o.label }))}
            />
          </EntryShell>
        )
      })}
      <div className="px-1.5 pt-1 pb-0.5">
        <ModelPicker
          availableOnly
          exclude={new Set(Object.keys(own))}
          onSelect={(m) =>
            void set(
              ['modelThinkingLevels', modelKey(m)],
              m.thinkingLevels.includes('high') ? 'high' : (m.thinkingLevels[0] ?? 'off')
            )
          }
          trigger={
            <Button size="sm" variant="ghost" leading={<Plus />} disabled={disabled}>
              Add model
            </Button>
          }
        />
      </div>
    </div>
  )
}

// ─── Enabled models (cycling scope) ────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/** Approximation of pi's --models matching: exact id, provider/id, globs; fuzzy name/id contains. */
export function matchModels(pattern: string, models: ModelInfo[]): ModelInfo[] {
  const base = pattern.replace(/:(off|minimal|low|medium|high|xhigh|max)$/i, '').trim()
  if (!base) return []
  if (base.includes('*') || base.includes('?')) {
    const re = globToRegex(base)
    return models.filter((m) => re.test(modelKey(m)) || re.test(m.id))
  }
  const exact = models.filter(
    (m) =>
      modelKey(m).toLowerCase() === base.toLowerCase() || m.id.toLowerCase() === base.toLowerCase()
  )
  if (exact.length) return exact
  const needle = base.toLowerCase()
  return models.filter(
    (m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)
  )
}

export function EnabledModelsEditor({
  resolved,
  disabled
}: {
  resolved: ResolvedSetting
  disabled: boolean
}) {
  const set = useSettings((s) => s.set)
  const { catalog } = useCatalog()
  const patterns = asStrings(resolved.value) ?? []
  const available = (catalog?.models ?? []).filter((m) => m.available)
  const matched = useMemo(() => {
    const keys = new Map<string, ModelInfo>()
    for (const p of patterns) for (const m of matchModels(p, available)) keys.set(modelKey(m), m)
    return [...keys.values()]
  }, [patterns, available])
  const write = (next: string[]) => void set('enabledModels', next.length ? next : undefined)
  return (
    <div className="space-y-2.5">
      <ListEditor
        value={patterns}
        mono
        disabled={disabled}
        placeholder="anthropic/*, gpt-5*, sonnet:high…"
        onChange={write}
        decorate={(p) => (
          <span
            className={cn(
              'size-1.5 rounded-full',
              matchModels(p, available).length ? 'bg-success' : 'bg-warning'
            )}
          />
        )}
      />
      <div className="flex items-center gap-2">
        <ModelPicker
          availableOnly
          exclude={new Set(patterns)}
          onSelect={(m) => write([...patterns, modelKey(m)])}
          trigger={
            <Button size="sm" variant="ghost" leading={<Plus />} disabled={disabled}>
              Add model
            </Button>
          }
        />
        <span className="text-sm text-fg-3">
          {patterns.length === 0 ? (
            'Cycling uses every available model.'
          ) : (
            <>
              <span className="tabular font-medium text-fg-2">{matched.length}</span> available{' '}
              {matched.length === 1 ? 'model' : 'models'} in the cycle
              {matched.length > 0 && (
                <span className="text-fg-3">
                  {' '}
                  ·{' '}
                  {matched
                    .slice(0, 4)
                    .map((m) => m.name)
                    .join(', ')}
                  {matched.length > 4 ? '…' : ''}
                </span>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  )
}

// ─── Default tools ─────────────────────────────────────────────────────────

const DEFAULT_TOOLS = ['read', 'bash', 'edit', 'write']
const TOOLS: Array<{ name: string; description: string; windowsOnly?: true }> = [
  { name: 'read', description: 'Read files and images' },
  { name: 'bash', description: 'Run shell commands' },
  { name: 'edit', description: 'Exact text replacements' },
  { name: 'write', description: 'Create or overwrite files' },
  { name: 'grep', description: 'Search file contents' },
  { name: 'find', description: 'Find paths by glob' },
  { name: 'ls', description: 'List directories' },
  { name: 'powershell', description: 'Run PowerShell (Windows)', windowsOnly: true },
  { name: 'codemode', description: 'Scripts that call other tools' },
  { name: 'tool_search', description: 'Load deferred tools on demand' }
]

const isModifier = (entry: string) => entry.startsWith('+') || entry.startsWith('-')

/** pi semantics: plain names form the selection, then +name / -name apply in order. */
export function resolveTools(base: string[], entries: string[] | undefined): string[] {
  if (!entries) return base
  const plain = entries.filter((e) => !isModifier(e))
  let result = plain.length > 0 ? [...plain] : [...base]
  for (const entry of entries.filter(isModifier)) {
    const name = entry.slice(1)
    if (entry.startsWith('+') && !result.includes(name)) result.push(name)
    if (entry.startsWith('-')) result = result.filter((t) => t !== name)
  }
  return result
}

export function DefaultToolsEditor({
  resolved,
  disabled
}: {
  resolved: ResolvedSetting
  disabled: boolean
}) {
  const scope = useSettings((s) => s.scope)
  const set = useSettings((s) => s.set)
  const own = resolved.setHere ? asStrings(resolved.value) : undefined
  // Project lists apply on top of the user's selection.
  const base =
    scope === 'project'
      ? resolveTools(DEFAULT_TOOLS, asStrings(resolved.globalValue))
      : DEFAULT_TOOLS
  const active = resolveTools(base, own)
  const replaceMode = !!own && own.some((e) => !isModifier(e))
  const writeAdjust = (next: string[]) => {
    const mods = [
      ...next.filter((t) => !base.includes(t)).map((t) => `+${t}`),
      ...base.filter((t) => !next.includes(t)).map((t) => `-${t}`)
    ]
    void set('defaultTools', mods.length ? mods : undefined)
  }
  const toggle = (name: string) => {
    const next = active.includes(name) ? active.filter((t) => t !== name) : [...active, name]
    if (replaceMode) void set('defaultTools', next)
    else writeAdjust(next)
  }
  const named = own?.map((e) => (isModifier(e) ? e.slice(1) : e)) ?? []
  const extras = named.filter((n) => !TOOLS.some((t) => t.name === n))
  // Windows-only tools fail on other systems: there they show only while a saved selection names them.
  const offered = TOOLS.filter(
    (t) => !t.windowsOnly || platform.os === 'win32' || named.includes(t.name) || base.includes(t.name)
  )
  return (
    <div className={cn('space-y-3', disabled && 'pointer-events-none opacity-60')}>
      <div className="flex items-center gap-3">
        <SegmentedControl
          size="sm"
          value={replaceMode ? 'replace' : 'adjust'}
          onValueChange={(mode) =>
            mode === 'replace' ? void set('defaultTools', active) : writeAdjust(active)
          }
          segments={[
            { value: 'adjust', label: 'Adjust defaults' },
            { value: 'replace', label: 'Exact selection' }
          ]}
        />
        <code className="min-w-0 truncate font-mono text-xs text-fg-3">
          {own ? JSON.stringify(own) : 'unset — read, bash, edit, write'}
        </code>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {[...offered, ...extras.map((name) => ({ name, description: 'Extension tool' }))].map(
          (tool) => {
            const on = active.includes(tool.name)
            return (
              <button
                key={tool.name}
                type="button"
                onClick={() => toggle(tool.name)}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-[background-color,box-shadow] duration-[var(--dur-fast)]',
                  on
                    ? 'bg-active shadow-[inset_0_0_0_1px_var(--hairline-strong)]'
                    : 'bg-surface-1 shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-hover'
                )}
              >
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-xs',
                    on
                      ? 'bg-control-on text-accent-fg'
                      : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)]'
                  )}
                >
                  {on && <Sparkles className="size-2.5" />}
                </span>
                <span className="min-w-0">
                  <span className="block font-mono text-sm text-fg">{tool.name}</span>
                  <span className="block truncate text-xs text-fg-3">{tool.description}</span>
                </span>
                {!base.includes(tool.name) && on && <Badge>Added</Badge>}
                {base.includes(tool.name) && !on && <Badge tone="warning">Removed</Badge>}
              </button>
            )
          }
        )}
      </div>
    </div>
  )
}

// ─── Compaction per-model overrides ────────────────────────────────────────

export function CompactionOverridesEditor({
  resolved,
  disabled
}: {
  resolved: ResolvedSetting
  disabled: boolean
}) {
  const scope = useSettings((s) => s.scope)
  const set = useSettings((s) => s.set)
  const lookup = useModelLookup()
  const own = asObject(resolved.setHere ? resolved.value : undefined)
  const inherited = inheritedEntries(resolved, scope)
  const keys = [...new Set([...Object.keys(own), ...Object.keys(inherited)])]
  const path = (model: string, field?: string) => [
    'compaction',
    'modelOverrides',
    model,
    ...(field ? [field] : [])
  ]
  return (
    <div
      className={cn(
        'rounded-card bg-surface-1 p-1 shadow-[inset_0_0_0_1px_var(--hairline)]',
        disabled && 'pointer-events-none'
      )}
    >
      {keys.length > 0 && (
        <div className="flex items-center gap-3 px-2.5 pt-1.5 pb-1 text-xs font-medium text-fg-3">
          <span className="flex-1">Model</span>
          <span className="w-[136px] text-right">Reserve</span>
          <span className="w-[136px] text-right">Keep recent</span>
          <span className="size-6" />
        </div>
      )}
      {keys.length === 0 && (
        <div className="px-3 py-2.5 text-sm text-fg-3">
          No overrides. Every model uses the values above.
        </div>
      )}
      {keys.map((key) => {
        const isOwn = key in own
        const entry = asObject(isOwn ? own[key] : inherited[key])
        return (
          <EntryShell
            key={key}
            model={lookup.get(key)}
            fallback={key}
            inherited={!isOwn}
            onRemove={isOwn ? () => void set(path(key), undefined) : undefined}
          >
            {(['reserveTokens', 'keepRecentTokens'] as const).map((field) => (
              <NumberField
                key={field}
                aria-label={field}
                value={typeof entry[field] === 'number' ? (entry[field] as number) : undefined}
                placeholder="—"
                min={0}
                integer
                unit="tokens"
                showHint={false}
                onCommit={(v) => void set(path(key, field), v)}
              />
            ))}
          </EntryShell>
        )
      })}
      <div className="px-1.5 pt-1 pb-0.5">
        <ModelPicker
          exclude={new Set(Object.keys(own))}
          onSelect={(m) => void set(path(modelKey(m), 'reserveTokens'), 30000)}
          trigger={
            <Button size="sm" variant="ghost" leading={<Plus />} disabled={disabled}>
              Add override
            </Button>
          }
        />
      </div>
    </div>
  )
}
