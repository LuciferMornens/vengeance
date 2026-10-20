import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, RefreshCw, RotateCw, Settings2 } from 'lucide-react'
import {
  mcpLiveCounts,
  mcpSwitchAction,
  type McpLiveAction,
  type McpLiveServer,
  type McpLiveState,
  type McpLiveStatus,
  type McpSwitchScope
} from '@shared/api/mcp'
import { friendlyExtensionName } from '@shared/display-names'
import { cn } from '../../lib/cn'
import { on } from '../../lib/ipc'
import { spring } from '../../lib/motion'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { Button, IconButton, Popover, Switch, toast, Tooltip } from '../../ui'
import { LoginDialog, useLoginFlow } from '../settings/auth-flow'
import { refreshMcp, runMcpAction, signInInConversation } from './actions'
import { MCP_DOT, mcpStateText, mcpStateTone } from './status'

/**
 * Engine 2 reports no MCP changes by itself, so it is asked again this often while the panel is open
 * or a server is still connecting.
 */
const PANEL_REFRESH_MS = 5_000
/** While the panel is closed, the chip still follows servers that connect, fail or drop. */
const CHIP_REFRESH_MS = 30_000
/**
 * Reads in a row that follow a connecting server at PANEL_REFRESH_MS while the panel is closed: each
 * read can start the server again.
 */
const CONNECTING_FOLLOW_UPS = 2
/** Engine 2 opens its MCP servers in the background after start; ask once they had a moment. */
const FIRST_READ_DELAY_MS = 4_000

function summaryTone(status: McpLiveStatus): McpLiveState {
  if (status.servers.length === 0) return status.errors.length > 0 ? 'failed' : 'idle'
  const servers = status.servers.filter((s) => s.state !== 'disabled' && s.state !== 'blocked')
  if (servers.some((s) => s.state === 'failed')) return 'failed'
  if (servers.some((s) => s.state === 'needs-auth')) return 'needs-auth'
  if (servers.some((s) => s.state === 'connecting')) return 'connecting'
  if (servers.length > 0 && servers.every((s) => s.state === 'connected')) return 'connected'
  return 'idle'
}

type Pending = McpLiveAction | 'sign-in'

/** Where a switch saves: its tooltip, and the words its accessible name ends with. */
const SWITCH_SAVES: Record<McpSwitchScope, { tooltip: string; scope: string }> = {
  project: { tooltip: 'Saved to the project mcp.json, for this folder only', scope: 'for this folder' },
  global: { tooltip: 'Saved to the global mcp.json, for every folder', scope: 'in every folder' },
  session: { tooltip: 'For this conversation only, not saved', scope: 'for this conversation' }
}

/**
 * The panel's line for switches that change every folder; the Engine offers that only where it
 * cannot save for the folder alone, such as an untrusted folder.
 */
function globalSwitchNote(servers: McpLiveServer[]): string | undefined {
  const switches = servers.filter((server) => server.toggle)
  const global = switches.filter((server) => server.saves === 'global')
  if (global.length === 0) return undefined
  if (global.length === switches.length) return 'Switches save to the global mcp.json, for every folder.'
  const names = new Intl.ListFormat('en').format(global.map((server) => server.name))
  return `Switches of ${names} save to the global mcp.json, for every folder.`
}

function ServerRow({
  server,
  status,
  pending,
  onAction,
  onSignIn
}: {
  server: McpLiveServer
  status: McpLiveStatus
  pending: Pending | undefined
  onAction: (action: McpLiveAction) => void
  onSignIn: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const off = server.state === 'disabled' || server.state === 'blocked'
  // Engine 2 reconnects only the servers its running kernel lists. It changes on/off in Settings;
  // its catalog sign-in runs there as well.
  const canReconnect = !off && server.state !== 'needs-auth' && server.reconnectable !== false
  // The Engine is already connecting a server it reports so; Engine 2 reconnects at once, also one
  // its status read had still opening.
  const reconnectWaits = server.state === 'connecting' && status.source !== 'prime'
  const canSignIn = server.state === 'needs-auth' && (status.source !== 'prime' || server.oauth)
  const canSignOut = server.oauth && server.state === 'connected' && status.source !== 'adapter'
  const saves = server.toggle ? server.saves : undefined
  return (
    <div data-mcp-server={server.name} data-mcp-state={server.state} className="rounded-md px-2.5 py-2 hover:bg-hover">
      <div className="flex items-center gap-2.5">
        <span className={cn('size-2 shrink-0 rounded-full', MCP_DOT[server.state])} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-sm font-medium', off ? 'text-fg-3' : 'text-fg')}>{server.name}</div>
          <div className={cn('truncate text-xs', mcpStateTone(server.state))}>{mcpStateText(server)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canSignIn && (
            <Button size="xs" loading={pending === 'sign-in'} onClick={onSignIn}>
              Sign in
            </Button>
          )}
          {canSignOut && (
            <Button size="xs" variant="ghost" loading={pending === 'logout'} onClick={() => onAction('logout')}>
              Sign out
            </Button>
          )}
          {canReconnect && (
            <IconButton
              label={`Reconnect ${server.name}`}
              size="xs"
              disabled={pending !== undefined || reconnectWaits}
              onClick={() => onAction('reconnect')}
            >
              <RotateCw className={cn(pending === 'reconnect' && 'animate-spin')} />
            </IconButton>
          )}
          {saves && (
            <Tooltip content={SWITCH_SAVES[saves].tooltip} side="right">
              <span className="inline-flex">
                <Switch
                  size="sm"
                  aria-label={`${server.state === 'disabled' ? 'Turn on' : 'Turn off'} ${server.name} ${SWITCH_SAVES[saves].scope}`}
                  checked={server.state !== 'disabled'}
                  disabled={pending !== undefined}
                  onCheckedChange={(checked) => onAction(mcpSwitchAction(server, checked))}
                />
              </span>
            </Tooltip>
          )}
        </div>
      </div>
      {server.error && !off && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 ml-[18px] flex w-[calc(100%-18px)] items-start gap-1 text-left text-xs text-fg-3 hover:text-fg-2"
        >
          <ChevronRight className={cn('mt-0.5 size-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
          <span className={cn('selectable font-mono break-words whitespace-pre-wrap', !expanded && 'line-clamp-2')}>
            {server.error}
          </span>
        </button>
      )}
    </div>
  )
}

function McpPanel({
  agentId,
  status,
  onSignIn,
  onClose
}: {
  agentId: string
  status: McpLiveStatus
  onSignIn: (server: string) => Promise<void>
  onClose: () => void
}) {
  const engine = useAgents((s) => s.agents[agentId]?.info.engine)
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [refreshing, setRefreshing] = useState(false)
  const counts = mcpLiveCounts(status)
  const switchNote = globalSwitchNote(status.servers)

  const run = async (server: string, kind: Pending, work: () => Promise<void>) => {
    setPending((current) => ({ ...current, [server]: kind }))
    try {
      await work()
    } catch (error) {
      toast({ level: 'error', title: `${server}: action failed`, description: (error as Error).message })
    } finally {
      setPending(({ [server]: _done, ...rest }) => rest)
    }
  }
  const refresh = async () => {
    setRefreshing(true)
    try {
      await refreshMcp(agentId)
    } catch (error) {
      toast({ level: 'error', title: 'Could not read MCP servers', description: (error as Error).message })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="flex max-h-[440px] flex-col" data-mcp-panel>
      <div className="flex h-8 shrink-0 items-center gap-2 px-2.5">
        <span className="heading text-sm font-semibold text-fg">MCP servers</span>
        <span className="flex-1" />
        {status.live && status.servers.length > 0 && (
          <span className="tabular text-xs text-fg-3">
            {counts.connected} of {counts.enabled} connected
          </span>
        )}
        <IconButton label="Check again" size="xs" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
        </IconButton>
      </div>
      {!status.live && (
        <p className="px-2.5 pb-1.5 text-xs text-fg-3">
          Engine 2 opens these servers once this conversation’s Python runtime starts. Until then,
          their states come from your MCP settings.
        </p>
      )}
      {status.errors.map((error) => (
        <p key={error} className="selectable px-2.5 pb-1.5 text-xs text-danger">
          {error}
        </p>
      ))}
      <div className="-mx-1.5 min-h-0 flex-1 overflow-y-auto px-1.5">
        {status.servers.map((server) => (
          <ServerRow
            key={server.name}
            server={server}
            status={status}
            pending={pending[server.name]}
            onAction={(action) =>
              void run(server.name, action, () => runMcpAction(agentId, status, server.name, action))
            }
            onSignIn={() => void run(server.name, 'sign-in', () => onSignIn(server.name))}
          />
        ))}
      </div>
      {switchNote && <p className="shrink-0 px-2.5 pt-1.5 text-xs text-fg-3">{switchNote}</p>}
      <div className="mt-1 flex shrink-0 items-center gap-2 border-t border-hairline-soft px-1 pt-1.5">
        {status.source === 'adapter' ? (
          <span className="px-1.5 text-xs text-fg-3">
            Configured by the {friendlyExtensionName('pi-mcp-adapter')} extension. Type /mcp for
            more.
          </span>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            leading={<Settings2 />}
            onClick={() => {
              onClose()
              useApp.getState().openSettings('mcp', engine)
            }}
          >
            MCP settings
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Engine 2 reports MCP state only when asked. The active conversation asks soon after start (at
 * once when it reported before), after each turn (its tools may have started the kernel or a
 * server), and then every CHIP_REFRESH_MS, or every PANEL_REFRESH_MS while the panel is open or,
 * CONNECTING_FOLLOW_UPS times, while a server is still connecting. A hidden window does not ask;
 * showing it again asks at once. `refreshMcp` keeps one read in flight per conversation.
 */
function usePrimeMcpReads(agentId: string, enabled: boolean, open: boolean): void {
  const openRef = useRef(open)
  const readNow = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let followUps = 0
    const read = async (): Promise<void> => {
      clearTimeout(timer)
      timer = undefined
      if (document.hidden) return
      await refreshMcp(agentId).catch(() => undefined)
      // Another read that started meanwhile already scheduled the next one.
      if (stopped || timer !== undefined) return
      const connecting = useAgents
        .getState()
        .agents[agentId]?.mcp?.servers.some((server) => server.state === 'connecting')
      followUps = connecting && !openRef.current ? followUps + 1 : 0
      const delay =
        openRef.current || (connecting && followUps <= CONNECTING_FOLLOW_UPS)
          ? PANEL_REFRESH_MS
          : CHIP_REFRESH_MS
      timer = setTimeout(() => void read(), delay)
    }
    readNow.current = () => void read()
    const reported = useAgents.getState().agents[agentId]?.mcp !== undefined
    timer = setTimeout(() => void read(), reported ? 0 : FIRST_READ_DELAY_MS)
    const onVisibility = () => {
      if (!document.hidden) void read()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const unsubscribe = on('engine:event', ({ agentId: source, event }) => {
      if (source === agentId && event.type === 'agent_end') void read()
    })
    return () => {
      stopped = true
      clearTimeout(timer)
      readNow.current = undefined
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribe()
    }
  }, [agentId, enabled])
  useEffect(() => {
    openRef.current = open
    if (open) readNow.current?.()
  }, [open])
}

interface ChipText {
  label: string
  /** Muted, after the label: why it shows no counts. */
  note?: string
  /** In the danger colour: no server could be loaded. */
  problem?: string
  attention?: string
  /** The same for a screen reader. */
  spoken: string
}

function chipText(status: McpLiveStatus): ChipText {
  // Configuration errors alone: the panel lists them.
  if (status.servers.length === 0) {
    return { label: 'MCP', problem: 'config error', spoken: 'MCP servers: configuration error' }
  }
  const counts = mcpLiveCounts(status)
  const attention =
    counts.attention > 0
      ? `${counts.attention} ${counts.attention === 1 ? 'needs' : 'need'} attention`
      : undefined
  const spoken = (text: string) => [text, attention].filter(Boolean).join(', ')
  if (!status.live) {
    return {
      label: 'MCP',
      note: 'not started',
      attention,
      spoken: spoken(`MCP servers: ${counts.enabled}, not started yet`)
    }
  }
  return {
    label: `MCP ${counts.connected}/${counts.enabled}`,
    attention,
    spoken: spoken(`MCP servers: ${counts.connected} of ${counts.enabled} connected`)
  }
}

/**
 * The conversation's MCP servers at a glance, in the row above the composer: how many are connected,
 * with the worst state as its dot. Opens a panel listing every server with its state, error and actions.
 */
export function McpChip({ agentId }: { agentId: string }) {
  const engine = useAgents((s) => s.agents[agentId]?.info.engine)
  const cwd = useAgents((s) => s.agents[agentId]?.info.cwd)
  const ready = useAgents((s) => s.agents[agentId]?.status === 'ready')
  const status = useAgents((s) => s.agents[agentId]?.mcp)
  const [open, setOpen] = useState(false)
  const visible = !!status && (status.servers.length > 0 || status.errors.length > 0)
  usePrimeMcpReads(agentId, engine === 'prime' && ready, open && visible)
  // A restart clears the status: the panel closes with the chip, not to reopen by itself later.
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])
  const loginFlow = useLoginFlow((ok) => {
    if (ok) void refreshMcp(agentId).catch(() => undefined)
  })

  const signIn = async (server: string) => {
    if (!status) return
    if (status.source !== 'prime') {
      setOpen(false)
      await signInInConversation(agentId, status, server)
      return
    }
    setOpen(false)
    await loginFlow.start({ id: `mcp:${server}`, name: server }, 'oauth', { engine: 'prime', cwd: cwd ?? undefined })
  }

  const tone = status ? summaryTone(status) : 'idle'
  const text = status ? chipText(status) : undefined

  return (
    <>
      <LoginDialog flow={loginFlow} />
      <AnimatePresence initial={false}>
        {visible && status && text && (
          <motion.div
            key="mcp"
            layout
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={spring.snappy}
            className="shrink-0"
          >
            <Popover
              open={open}
              onOpenChange={setOpen}
              side="top"
              align="start"
              className="w-[380px] p-1.5"
              focusContent
              trigger={
                <button
                  type="button"
                  data-mcp-chip={tone}
                  aria-label={text.spoken}
                  className="pressable inline-flex h-[22px] items-center gap-1.5 rounded-sm bg-[var(--glass-strong)] px-2 text-xs text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)] backdrop-blur-xl transition-colors duration-[var(--dur-instant)] hover:text-fg focus-visible:-outline-offset-2"
                >
                  <span className={cn('size-1.5 shrink-0 rounded-full', MCP_DOT[tone])} aria-hidden />
                  <span className="tabular">{text.label}</span>
                  {text.note && <span className="text-fg-3">· {text.note}</span>}
                  {text.problem && <span className="text-danger">· {text.problem}</span>}
                  {text.attention && <span className="text-warning">· {text.attention}</span>}
                </button>
              }
            >
              <McpPanel agentId={agentId} status={status} onSignIn={signIn} onClose={() => setOpen(false)} />
            </Popover>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
