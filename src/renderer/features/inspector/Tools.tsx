import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Blocks, Search, Server, SlidersHorizontal, Wrench, X } from 'lucide-react'
import type { BridgeToolExposure, BridgeToolInfo, BridgeToolsState } from '@shared/api/engine'
import { friendlyExtensionName } from '@shared/display-names'
import { bridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { basename } from '../../lib/format'
import { fadeUp, stagger } from '../../lib/motion'
import type { AgentState } from '../../store/agent-state'
import { useApp } from '../../store/app'
import { Badge, Button, Input, Skeleton, Switch, toast, Tooltip } from '../../ui'
import { openLaunchDialog } from '../launch'
import { Section, TabEmpty, Well } from './parts'

type GroupKind = 'builtin' | 'extension' | 'mcp'

interface ToolGroup {
  key: string
  kind: GroupKind
  title: string
  /** Package id behind an extension group's friendly title (tooltip). */
  technical?: string
  tools: BridgeToolInfo[]
}

const EXPOSURE: Partial<Record<BridgeToolExposure, { label: string; hint: string }>> = {
  'model-only': {
    label: 'Model only',
    hint: 'Declared to the model, never called by other tools.'
  },
  codemode: {
    label: 'Code mode',
    hint: 'Callable from code mode even when off. On also declares it to the model.'
  },
  deferred: {
    label: 'On demand',
    hint: 'Found through tool search even when off. On also declares it to the model.'
  },
  hidden: { label: 'Hidden', hint: 'Registered but unreachable, so it cannot be turned on.' }
}

/** MCP server of a tool (`mcp__<server>__<tool>` or its namespace), if it is one. */
function mcpServer(tool: BridgeToolInfo): string | null {
  const name = tool.namespace ?? tool.name
  const match = /^mcp__([^_]+(?:_[^_]+)*?)(?:__|$)/.exec(name)
  return match ? match[1]! : null
}

/** Package or file an extension tool comes from (`npm:pi-todos` → `pi-todos`; shown through friendlyExtensionName). */
function extensionName(tool: BridgeToolInfo): string {
  const info = tool.sourceInfo
  if (info.baseDir) return basename(info.baseDir)
  if (info.source && info.source !== 'local' && info.source !== 'cli')
    return info.source.replace(/^(npm|git):/, '')
  return basename(info.path).replace(/\.[jt]s$/, '')
}

/** Display name of a tool inside its group (MCP tools drop their `mcp__server__` prefix). */
function toolLabel(tool: BridgeToolInfo, group: ToolGroup): string {
  return group.kind === 'mcp' ? tool.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '') : tool.name
}

function groupTools(tools: BridgeToolInfo[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>()
  for (const tool of tools) {
    const server = mcpServer(tool)
    const kind: GroupKind = server
      ? 'mcp'
      : tool.sourceInfo.source === 'builtin'
        ? 'builtin'
        : 'extension'
    const name = server ?? (kind === 'builtin' ? 'Built-in' : extensionName(tool))
    const key = `${kind}:${name}`
    const group = groups.get(key) ?? {
      key,
      kind,
      title: kind === 'extension' ? friendlyExtensionName(name) : name,
      technical: kind === 'extension' ? name : undefined,
      tools: []
    }
    group.tools.push(tool)
    groups.set(key, group)
  }
  const order: Record<GroupKind, number> = { builtin: 0, extension: 1, mcp: 2 }
  return [...groups.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title)
  )
}

const GROUP_ICON: Record<GroupKind, typeof Wrench> = {
  builtin: Wrench,
  extension: Blocks,
  mcp: Server
}

function ToolRow({
  tool,
  label,
  on,
  pending,
  onToggle
}: {
  tool: BridgeToolInfo
  label: string
  on: boolean
  pending: boolean
  onToggle: (on: boolean) => void
}) {
  const exposure = EXPOSURE[tool.exposure]
  const hidden = tool.exposure === 'hidden'
  const readOnly = tool.annotations?.readOnlyHint === true
  return (
    <motion.label
      variants={fadeUp}
      className={cn(
        'flex items-start gap-3 px-3 py-2.5',
        hidden ? 'cursor-default' : 'cursor-pointer hover:bg-hover'
      )}
    >
      <span className="min-w-0 flex-1">
        {/* Badges wrap below the name before the name truncates. */}
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span
            className={cn('min-w-0 truncate font-mono text-xs', on ? 'text-fg' : 'text-fg-2')}
            title={label}
          >
            {label}
          </span>
          {exposure && (
            <Tooltip content={exposure.hint}>
              <Badge>{exposure.label}</Badge>
            </Tooltip>
          )}
          {readOnly && <Badge>Read-only</Badge>}
        </span>
        {tool.description && (
          <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-fg-3">
            {tool.description}
          </span>
        )}
      </span>
      <Switch
        size="sm"
        checked={on}
        disabled={hidden || pending}
        onCheckedChange={onToggle}
        aria-label={`${on ? 'Turn off' : 'Turn on'} ${label}`}
        className="mt-0.5"
      />
    </motion.label>
  )
}

function GroupSection({
  group,
  active,
  pending,
  onSet
}: {
  group: ToolGroup
  active: Set<string>
  pending: boolean
  onSet: (names: string[], on: boolean) => void
}) {
  const Icon = GROUP_ICON[group.kind]
  const switchable = group.tools.filter((t) => t.exposure !== 'hidden')
  const onCount = group.tools.filter((t) => active.has(t.name)).length
  const allOn = switchable.length > 0 && switchable.every((t) => active.has(t.name))
  const title = (
    <span className="flex items-center gap-1.5">
      <Icon className="size-3.5 text-fg-3" />
      <span className="truncate" title={group.technical}>
        {group.kind === 'mcp' ? `${group.title} · MCP` : group.title}
      </span>
      <span className="tabular text-fg-3">
        {onCount}/{group.tools.length}
      </span>
    </span>
  )
  return (
    <Section
      title={title}
      aside={
        switchable.length > 1 && (
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              onSet(
                switchable.map((t) => t.name),
                !allOn
              )
            }
            className="-mr-1 text-fg-3"
          >
            {allOn ? 'Turn all off' : 'Turn all on'}
          </Button>
        )
      }
    >
      <Well className="overflow-hidden">
        <motion.div
          variants={stagger()}
          initial="hidden"
          animate="show"
          className="divide-y divide-hairline-soft"
        >
          {group.tools.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              label={toolLabel(tool, group)}
              on={active.has(tool.name)}
              pending={pending}
              onToggle={(on) => onSet([tool.name], on)}
            />
          ))}
        </motion.div>
      </Well>
    </Section>
  )
}

function ToolsSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 pt-4">
      <Skeleton className="h-7" />
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2 pt-2">
          <Skeleton className="h-2.5 w-1/4" />
          <Skeleton className="h-28 rounded-card" />
        </div>
      ))}
    </div>
  )
}

/** Session-level tool switches (engine `setActiveTools` through the bridge): what the model is offered right now. */
export function Tools({ agent }: { agent: AgentState }) {
  const [state, setState] = useState<BridgeToolsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState('')
  const live = bridge.available(agent.id)
  const ready = agent.status === 'ready'

  const load = useCallback(async () => {
    if (!live || !ready) return
    try {
      setState(await bridge.getTools(agent.id))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [agent.id, live, ready])

  // Reload when capabilities change (reload, resource toggles, package updates).
  useEffect(() => {
    void load()
  }, [load, agent.commands])

  const active = useMemo(() => new Set(state?.active ?? []), [state])
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const tools = (state?.tools ?? []).filter(
      (t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q)
    )
    return groupTools(tools)
  }, [state, query])

  const setTools = async (names: string[], on: boolean) => {
    if (!state) return
    const next = on
      ? [...new Set([...state.active, ...names])]
      : state.active.filter((n) => !names.includes(n))
    const previous = state
    setState({ ...state, active: next })
    setPending(true)
    try {
      setState(await bridge.setTools(agent.id, next))
    } catch (e) {
      setState(previous)
      toast({ level: 'error', title: 'Could not change tools', description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  if (!live) {
    return (
      <TabEmpty icon={<SlidersHorizontal />} title="Tool switches are unavailable">
        <span className="block">
          This engine started without the desktop bridge, so tools can only be chosen when a session
          starts.
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="mt-4"
          onClick={() => openLaunchDialog('session', agent.info.cwd, agent.info.engine)}
        >
          New session with options…
        </Button>
      </TabEmpty>
    )
  }
  if (error && !state)
    return (
      <TabEmpty icon={<Wrench />} title="Could not load tools">
        {error}
      </TabEmpty>
    )
  if (!state) return <ToolsSkeleton />

  const total = state.tools.length
  const onCount = state.tools.filter((t) => active.has(t.name)).length

  return (
    <div className="flex flex-col gap-5 px-4 pt-3 pb-6">
      <div className="flex flex-col gap-2">
        <Input
          inputSize="sm"
          leading={<Search />}
          placeholder="Filter tools"
          aria-label="Filter tools"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          trailing={
            query ? (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery('')}
                className="rounded-xs p-0.5 text-fg-3 hover:bg-active hover:text-fg"
              >
                <X className="size-3" />
              </button>
            ) : undefined
          }
        />
        <span className="px-0.5 text-xs text-fg-3">
          <span className="tabular text-fg-2">{onCount}</span> of{' '}
          <span className="tabular text-fg-2">{total}</span> tools offered to the model in this
          session
        </span>
      </div>
      {groups.map((group) => (
        <GroupSection
          key={group.key}
          group={group}
          active={active}
          pending={pending}
          onSet={(names, on) => void setTools(names, on)}
        />
      ))}
      {groups.length === 0 && (
        <div className="py-6 text-center text-sm text-fg-3">No tool matches “{query}”.</div>
      )}
      <p className="px-0.5 text-2xs leading-relaxed text-fg-3">
        Changes apply to this session right away. Defaults for new sessions live in{' '}
        <button
          type="button"
          className="text-fg-2 underline decoration-hairline-strong underline-offset-2 hover:text-fg"
          onClick={() => {
            useApp.getState().openSettings('agent', agent.info.engine)
          }}
        >
          Agent behavior
        </button>
        .
      </p>
    </div>
  )
}
