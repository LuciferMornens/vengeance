import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import {
  ChevronRight,
  CircleAlert,
  FileText,
  FolderGit2,
  Globe,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Terminal,
  Trash2
} from 'lucide-react'
import type { McpLiveState } from '@shared/api/mcp'
import type {
  McpOverview,
  McpServerInfo,
  McpServerPatch,
  McpServerStatus,
  TextTail
} from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import { invoke, on, settingsInvokeForFolder } from '../ipc'
import {
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  type MenuItem,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  toast,
  Tooltip
} from '../../../ui'
import { Callout, Group, KeyHint, Note, Row, UntrustedProjectCallout } from '../layout'
import { mcpFailureReason } from '../mcp-error'
import { ProcessLog, useRuns } from '../process-log'
import { activeCwd } from '../store'
import { EXPOSURE_OPTIONS, ServerEditor, type EditorTarget } from './mcp-editor'
import {
  MCP_DOT,
  mcpStateTone,
  plural,
  workspaceStateText,
  type WorkspaceMcpServer
} from '../../mcp/status'
import {
  canReconnectInSessions,
  connectingInSessions,
  reconnectInSessions,
  useWorkspaceMcp
} from '../../mcp/workspace'

/** MCP servers the engine's built-in MCP adapter connects to (mcp.json global + project), pi docs/mcp.md. */

const LOG_BYTES = 48 * 1024

/** What a row shows: the state in the open conversations when one runs the server, else the last test. */
interface RowStatus {
  state: McpLiveState
  text: string
  /** The full failure, when `text` shows only part of it. */
  details: string | null
  live: boolean
}

function liveRowStatus(entry: WorkspaceMcpServer): RowStatus {
  const full = entry.server.error?.trim()
  return {
    state: entry.server.state,
    text: workspaceStateText(entry),
    details: entry.server.state === 'failed' && full && full !== mcpFailureReason(full) ? full : null,
    live: true
  }
}

function testedRowStatus(status: McpServerStatus | undefined, loading: boolean): RowStatus {
  if (!status) {
    return { state: loading ? 'connecting' : 'idle', text: loading ? 'Testing…' : 'Not tested', details: null, live: false }
  }
  if (status.state === 'connected') {
    const resources = status.resources
      ? ` · ${plural(status.resources, 'resource')}`
      : status.supportsResources
        ? ' · resources'
        : ''
    return {
      state: 'connected',
      text: `Test connected · ${plural(status.tools.length, 'tool')}${resources}`,
      details: null,
      live: false
    }
  }
  if (status.state === 'needs-auth') return { state: 'needs-auth', text: 'Needs sign-in', details: null, live: false }
  const full = status.error?.trim()
  return {
    state: 'failed',
    text: full ? `Test failed: ${mcpFailureReason(full)}` : `Test failed: ${status.state}`,
    details: full && full !== mcpFailureReason(full) ? full : null,
    live: false
  }
}

// ─── Log ────────────────────────────────────────────────────────────────────

function ServerLog() {
  const [open, setOpen] = useState(false)
  const [tail, setTail] = useState<TextTail | null>(null)
  const load = useCallback(() => void invoke('settings:mcp-log', LOG_BYTES).then(setTail), [])
  useEffect(() => {
    if (open) load()
  }, [open, load])
  return (
    <Row
      label="Server log"
      description={
        <>
          Logging notifications from servers, appended to <KeyHint>mcp.log</KeyHint> in the
          configuration folder.
        </>
      }
      below={
        open && (
          <pre className="selectable max-h-56 overflow-auto rounded-md bg-surface-1 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
            {tail === null
              ? 'Loading…'
              : tail.exists
                ? tail.text.trim() || 'The log is empty.'
                : 'No log yet. It appears once a server reports something.'}
          </pre>
        )
      }
    >
      <div className="flex items-center gap-1.5">
        {open && (
          <IconButton label="Refresh log" size="sm" onClick={load}>
            <RefreshCw />
          </IconButton>
        )}
        <Button
          size="sm"
          variant="secondary"
          leading={<FileText />}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Show log'}
        </Button>
      </div>
    </Row>
  )
}

// ─── Section ────────────────────────────────────────────────────────────────

function CodemodeGroup({
  overview,
  onChange
}: {
  overview: McpOverview
  onChange: (overview: McpOverview) => void
}) {
  const hasProject = !!overview.projectConfig
  const set = async (scope: 'global' | 'project', value: boolean | null) => {
    try {
      onChange(await invoke('settings:mcp-codemode', activeCwd(), scope, value))
    } catch (error) {
      toast({ level: 'error', title: 'Not saved', description: (error as Error).message })
    }
  }
  const project = overview.autoEnableCodemodeProject
  return (
    <Group title="Code mode">
      <Row
        label="Turn on code mode automatically"
        description="Activates the codemode tool when a server with code-mode exposure connects."
        badges={project !== undefined ? <Badge>Overridden in project</Badge> : undefined}
      >
        <Switch
          aria-label="Turn on code mode automatically"
          checked={overview.autoEnableCodemodeGlobal !== false}
          onCheckedChange={(on) => void set('global', on ? null : false)}
        />
      </Row>
      {hasProject && (
        <Row label="In this project" description="A project value wins over the global one.">
          <SegmentedControl
            value={project === undefined ? 'inherit' : project ? 'on' : 'off'}
            onValueChange={(v) => void set('project', v === 'inherit' ? null : v === 'on')}
            segments={[
              { value: 'inherit', label: 'Inherit' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' }
            ]}
          />
        </Row>
      )}
    </Group>
  )
}

export function McpSection() {
  const [overview, setOverview] = useState<McpOverview | null>(null)
  const [status, setStatus] = useState<Record<string, McpServerStatus>>({})
  const [statusLoading, setStatusLoading] = useState(false)
  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const [detailsFor, setDetailsFor] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<string | null>(null)
  const run = useRuns((s) => (activeRun ? s.runs[activeRun] : undefined))
  const closeEditor = useCallback(() => setEditing(null), [])
  const live = useWorkspaceMcp('pi', activeCwd())

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const list = await invoke('settings:mcp-status', activeCwd())
      setStatus(Object.fromEntries(list.map((s) => [s.name, s])))
    } catch {
      setStatus({})
    } finally {
      setStatusLoading(false)
    }
  }, [])
  const reload = useCallback(async () => {
    setOverview(await invoke('settings:mcp', activeCwd()))
    void loadStatus()
  }, [loadStatus])
  useEffect(() => {
    void reload()
    return on('settings:changed', ({ area }) => {
      if (area === 'mcp' || area === 'resources' || area === 'trust') void reload()
    })
  }, [reload])

  const update = async (server: McpServerInfo, patch: McpServerPatch) => {
    try {
      setOverview(await invoke('settings:mcp-update', activeCwd(), server.name, patch))
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not update server',
        description: (error as Error).message
      })
    }
  }
  const remove = async (server: McpServerInfo) => {
    try {
      setOverview(
        await invoke('settings:mcp-remove', activeCwd(), server.name, server.scope === 'project')
      )
      toast({ level: 'info', title: `Removed ${server.name}` })
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not remove server',
        description: (error as Error).message
      })
    }
  }
  const auth = async (server: McpServerInfo, action: 'login' | 'logout') => {
    const runId = await invoke('settings:mcp-auth', activeCwd(), server.name, action)
    useRuns
      .getState()
      .label(
        runId,
        `${action === 'login' ? 'Signing in to' : 'Signing out of'} ${server.name}`,
        'pi'
      )
    setActiveRun(runId)
  }
  const enableBuiltin = async () => {
    const cwd = activeCwd()
    const groups = await settingsInvokeForFolder('pi', cwd, 'settings:resources', cwd)
    const item = groups.flatMap((g) => g.items).find((i) => i.path === 'builtin:mcp')
    if (item)
      await settingsInvokeForFolder('pi', cwd, 'settings:resource-toggle', {
        cwd,
        item,
        enabled: true
      })
  }

  if (!overview) {
    return (
      <Group>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3.5 last:border-b-0"
          >
            <Skeleton className="size-8 rounded-card" />
            <Skeleton className="h-3.5 w-48" />
          </div>
        ))}
      </Group>
    )
  }

  const groups: { title: string; servers: McpServerInfo[] }[] = [
    { title: 'Global', servers: overview.servers.filter((s) => s.scope === 'global') },
    { title: 'This project', servers: overview.servers.filter((s) => s.scope === 'project') },
    { title: 'From extensions', servers: overview.servers.filter((s) => s.scope === 'extension') }
  ]

  const menuFor = (server: McpServerInfo): MenuItem[] => {
    const editable = server.scope !== 'extension'
    const items: MenuItem[] = []
    if (editable)
      items.push({
        label: 'Edit…',
        icon: <Pencil />,
        onSelect: () =>
          setEditing({
            name: server.name,
            scope: server.scope === 'project' ? 'project' : 'global'
          })
      })
    if (server.transport === 'http') {
      items.push(
        { label: 'Sign in', icon: <KeyRound />, onSelect: () => void auth(server, 'login') },
        { label: 'Sign out', icon: <LogOut />, onSelect: () => void auth(server, 'logout') }
      )
    }
    items.push({
      label: 'Reconnect in open sessions in this folder',
      icon: <RotateCw />,
      onSelect: () => void reconnectInSessions(server.name, live.get(server.name))
    })
    if (server.scope === 'global' && overview.projectConfig) {
      items.push({ kind: 'separator' })
      if (!server.override || !server.enabled)
        items.push({
          label: 'Enable in this project',
          icon: <FolderGit2 />,
          onSelect: () => void update(server, { enabled: true, projectOverride: 'set' })
        })
      if (!server.override || server.enabled)
        items.push({
          label: 'Disable in this project',
          icon: <FolderGit2 />,
          onSelect: () => void update(server, { enabled: false, projectOverride: 'set' })
        })
      if (server.override)
        items.push({
          label: 'Use the global setting here',
          icon: <Globe />,
          onSelect: () => void update(server, { projectOverride: 'clear' })
        })
    }
    items.push(
      { kind: 'separator' },
      {
        label: 'Reveal config',
        icon: <Server />,
        onSelect: () => void invoke('sys:reveal', server.override ?? server.source)
      }
    )
    if (editable)
      items.push({
        label: 'Remove',
        icon: <Trash2 />,
        danger: true,
        onSelect: () => void remove(server)
      })
    return items
  }

  return (
    <>
      {overview.builtinDisabled && (
        <Callout
          tone="warning"
          icon={<CircleAlert />}
          title="Built-in MCP support is turned off"
          action={
            <Button size="sm" variant="secondary" onClick={() => void enableBuiltin()}>
              Turn on
            </Button>
          }
        >
          Servers below are saved but not connected until the built-in MCP extension is enabled.
        </Callout>
      )}
      <div className="mb-5 flex items-center gap-2">
        <Button
          variant="primary"
          leading={<Plus />}
          onClick={() => setEditing({ name: null, scope: 'global' })}
        >
          Add server
        </Button>
        <Button
          variant="ghost"
          leading={<RefreshCw className={cn(statusLoading && 'animate-spin')} />}
          disabled={statusLoading}
          onClick={() => void loadStatus()}
        >
          Test connections
        </Button>
      </div>
      <AnimatePresence>
        {run && (
          <ProcessLog
            key={run.runId}
            run={run}
            cancellable
            className="mb-6"
            height={140}
            onDismiss={() => setActiveRun(null)}
          />
        )}
      </AnimatePresence>
      <UntrustedProjectCallout items="MCP servers" />
      {overview.errors.length > 0 && (
        <Group>
          {overview.errors.map((e, i) => (
            <Note key={i} tone="danger" icon={<CircleAlert />}>
              {e}
            </Note>
          ))}
        </Group>
      )}
      {overview.servers.length === 0 && (
        <Group>
          <Note icon={<Server />}>
            No MCP servers configured. Add one to give agents access to GitHub, databases, browsers
            and more.
          </Note>
        </Group>
      )}
      {groups
        .filter((g) => g.servers.length > 0)
        .map((group) => (
          <Group key={group.title} title={group.title}>
            {group.servers.map((server) => {
              const liveEntry = server.enabled ? live.get(server.name) : undefined
              const row: RowStatus = !server.enabled
                ? { state: 'disabled', text: 'Off', details: null, live: false }
                : liveEntry
                  ? liveRowStatus(liveEntry)
                  : testedRowStatus(status[server.name], statusLoading)
              const tone = overview.builtinDisabled ? 'disabled' : row.state
              const TransportIcon = server.transport === 'http' ? Globe : Terminal
              const editable = server.scope !== 'extension'
              const details = row.details
              const detailsOpen = !!details && detailsFor === server.name
              return (
                <Row
                  key={`${server.scope}:${server.name}`}
                  settingKey={`mcp.${server.name}`}
                  dimmed={!server.enabled}
                  below={
                    detailsOpen && (
                      <pre className="selectable max-h-56 overflow-auto rounded-md bg-surface-1 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
                        {details}
                      </pre>
                    )
                  }
                  label={
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() =>
                        setEditing({
                          name: server.name,
                          scope: server.scope === 'project' ? 'project' : 'global'
                        })
                      }
                      className="flex items-center gap-3 rounded-md text-left enabled:hover:text-fg-2"
                    >
                      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-card bg-surface-3 text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
                        <TransportIcon className="size-4" />
                      </span>
                      <span>{server.name}</span>
                    </button>
                  }
                  badges={
                    <>
                      <span
                        data-mcp-row-state={tone}
                        data-mcp-row-live={row.live || undefined}
                        className={cn(
                          'flex max-w-[52ch] items-center gap-1.5 text-xs break-words',
                          mcpStateTone(tone)
                        )}
                      >
                        <span className={cn('size-2 shrink-0 rounded-full', MCP_DOT[tone])} aria-hidden />
                        <span className="line-clamp-2">{row.text}</span>
                      </span>
                      {details && (
                        <button
                          type="button"
                          aria-expanded={detailsOpen}
                          onClick={() => setDetailsFor(detailsOpen ? null : server.name)}
                          className="flex h-5 items-center gap-0.5 rounded-xs px-1 text-xs font-medium text-fg-3 hover:bg-hover hover:text-fg-2"
                        >
                          <ChevronRight
                            className={cn(
                              'size-3 transition-transform',
                              detailsOpen && 'rotate-90'
                            )}
                          />
                          Details
                        </button>
                      )}
                      {server.override && (
                        <Tooltip content={`Project override in ${server.override}`}>
                          <span>
                            <Badge>
                              {server.enabled ? 'On in this project' : 'Off in this project'}
                            </Badge>
                          </span>
                        </Tooltip>
                      )}
                    </>
                  }
                  description={
                    <span className="ml-11 block">
                      <code className="line-clamp-1 font-mono text-xs text-fg-3">
                        {server.target}
                      </code>
                      {server.description && (
                        <span className="line-clamp-1">{server.description}</span>
                      )}
                    </span>
                  }
                >
                  <div className="flex items-center gap-2">
                    {canReconnectInSessions(liveEntry) && (
                      <IconButton
                        label={`Reconnect ${server.name} in open sessions in this folder`}
                        size="sm"
                        disabled={connectingInSessions(liveEntry)}
                        onClick={() => void reconnectInSessions(server.name, liveEntry)}
                      >
                        <RotateCw />
                      </IconButton>
                    )}
                    <Select
                      size="sm"
                      className="w-[124px]"
                      disabled={!editable}
                      value={server.exposure}
                      onValueChange={(exposure) => void update(server, { exposure })}
                      options={EXPOSURE_OPTIONS}
                    />
                    <Switch
                      aria-label={`Enable ${server.name}`}
                      checked={server.enabled}
                      disabled={!editable}
                      onCheckedChange={(enabled) => void update(server, { enabled })}
                    />
                    <DropdownMenu
                      align="end"
                      trigger={
                        <IconButton label="Server actions" size="sm">
                          <MoreHorizontal />
                        </IconButton>
                      }
                      items={menuFor(server)}
                    />
                  </div>
                </Row>
              )
            })}
          </Group>
        ))}
      <CodemodeGroup overview={overview} onChange={setOverview} />
      <Group title="Configuration">
        <Row
          label="Global"
          description={<code className="font-mono text-xs text-fg-3">{overview.globalPath}</code>}
        />
        {overview.projectPath && (
          <Row
            label="Project"
            badges={!overview.projectConfig ? <Badge tone="warning">Not trusted</Badge> : undefined}
            description={
              <code className="font-mono text-xs text-fg-3">{overview.projectPath}</code>
            }
          />
        )}
        <ServerLog />
      </Group>
      <ServerEditor target={editing} onClose={closeEditor} onSaved={setOverview} />
    </>
  )
}
