import type { McpLiveServer, McpLiveStatus } from '@shared/api/mcp'
import { asRecords, type PrimeRecord } from './transport'

/**
 * Engine 2's MCP status for one conversation: the connections its configuration and credentials
 * declare (`get_mcp_connections`), with what its kernel reports for each open server
 * (`get_mcp_status`, Vengeance patch 0024). Without a running kernel the states come from the
 * configuration only.
 */

/**
 * How long the kernel lets one server answer: in a status read (patch 0024's default) and in a
 * Reconnect (its maximum, the kernel's default start-up timeout). Both settle inside the
 * supervisor's 30 s route timeout.
 */
export const PRIME_MCP_READ_TIMEOUT_MS = 10_000
export const PRIME_MCP_RECONNECT_TIMEOUT_MS = 20_000

/** Catalog services the account set up; the rest of the catalog is only offered in Settings. */
const SET_UP_CATALOG_STATES = new Set(['connected', 'pending', 'error', 'disabled'])

/** The kernel's report of a server that did not answer within its listing's bound. */
const BARE_TIMEOUT = /^TimeoutError:\s*$/

const STALLED =
  `Did not answer within ${PRIME_MCP_READ_TIMEOUT_MS / 1000} s; ` +
  `Reconnect gives it ${PRIME_MCP_RECONNECT_TIMEOUT_MS / 1000} s.`

/**
 * The kernel bounds each server's listing and cancels an open that outlasts it, so a bare timeout
 * says only that the server did not answer in time. The first one since the server last answered,
 * the kernel started or a Reconnect ran reads as connecting: the server can still be opening, or
 * the listing waited behind a tool call or the start-up settle on that server. The next one reads
 * as failed. One per conversation, whose MCP requests run one at a time.
 */
export class PrimeMcpTimeouts {
  /** Kernel names whose listing timed out since they last answered. */
  private readonly timedOut = new Set<string>()

  /** Record what a listing reported: the names that timed out again. */
  settle(live: PrimeRecord | null): Set<string> {
    const stalled = new Set<string>()
    if (live?.kernelRunning !== true) {
      this.timedOut.clear()
      return stalled
    }
    for (const entry of asRecords(live.servers)) {
      if (typeof entry.server !== 'string') continue
      if (Array.isArray(entry.tools)) {
        this.timedOut.delete(entry.server)
      } else if (typeof entry.error === 'string' && BARE_TIMEOUT.test(entry.error)) {
        if (this.timedOut.has(entry.server)) stalled.add(entry.server)
        else this.timedOut.add(entry.server)
      }
    }
    return stalled
  }

  /** A Reconnect starts these kernel names afresh. */
  forget(names: readonly string[]): void {
    for (const name of names) this.timedOut.delete(name)
  }

  /** The conversation attached to a session again, whose kernel can be another one. */
  clear(): void {
    this.timedOut.clear()
  }
}

interface KernelEntry {
  tools?: number
  error?: string
  /** Its listing timed out again (`PrimeMcpTimeouts`). */
  stalled: boolean
}

function kernelEntries(
  live: PrimeRecord | null,
  stalled: ReadonlySet<string>
): Map<string, KernelEntry> {
  const entries = new Map<string, KernelEntry>()
  for (const entry of asRecords(live?.servers)) {
    if (typeof entry.server !== 'string') continue
    const error = typeof entry.error === 'string' ? entry.error.trim() : ''
    entries.set(entry.server, {
      ...(Array.isArray(entry.tools) ? { tools: entry.tools.length } : {}),
      ...(error ? { error } : {}),
      stalled: stalled.has(entry.server)
    })
  }
  return entries
}

/** The kernel reports failures as `ExceptionType: message`; the message can be empty. */
function kernelState(error: string, stalled: boolean): Pick<McpLiveServer, 'state' | 'error'> {
  const prefix = /^([A-Za-z_][\w.]*):(?:\s|$)/.exec(error)
  const type = prefix?.[1]
  const message = prefix ? error.slice(prefix[0].length).trim() : error
  if (type?.startsWith('McpCredentialsUnavailable')) {
    return { state: 'needs-auth', ...(message ? { error: message } : {}) }
  }
  if (/\bis disabled\b/.test(message)) return { state: 'disabled' }
  if (type === 'TimeoutError' && !message) {
    return stalled ? { state: 'failed', error: STALLED } : { state: 'connecting' }
  }
  return { state: 'failed', error: message || (type ?? error) }
}

function configuredState(
  status: string,
  hint: string | undefined,
  kernelRunning: boolean
): Pick<McpLiveServer, 'state' | 'error' | 'note'> {
  switch (status) {
    case 'disabled':
      return { state: 'disabled' }
    case 'pending':
      return { state: 'idle', note: 'Signed in; not verified yet' }
    case 'not_connected':
    case 'setup_required':
      return { state: 'needs-auth', ...(hint ? { error: hint } : {}) }
    case 'error':
      return { state: 'failed', ...(hint ? { error: hint } : {}) }
    default:
      return { state: 'idle', note: kernelRunning ? 'Connects on first use' : 'Not started yet' }
  }
}

/** The names a service runs under in the kernel: its own and a catalog service's connection ids. */
function serviceKernelIds(service: PrimeRecord, name: string): string[] {
  const connectionIds = Array.isArray(service.connectionIds) ? service.connectionIds : []
  return [name, ...connectionIds.filter((id): id is string => typeof id === 'string')]
}

/**
 * The kernel names behind one row of the status: a catalog service opens one connection per account
 * under its connection ids, a user server under its own name, and a server only the kernel lists is
 * its own row.
 */
export function primeKernelIds(connections: PrimeRecord, server: string): string[] {
  const service = asRecords(connections.services).find(
    (candidate) => candidate.serviceId === server
  )
  return service ? serviceKernelIds(service, server) : [server]
}

/** `stalled`: the kernel names whose listing timed out again (`PrimeMcpTimeouts.settle`). */
export function primeLiveMcpStatus(
  connections: PrimeRecord,
  live: PrimeRecord | null,
  stalled: ReadonlySet<string> = new Set()
): McpLiveStatus {
  const kernelRunning = live?.kernelRunning === true
  const kernel = kernelEntries(live, stalled)
  const servers: McpLiveServer[] = []
  const listed = new Set<string>()
  for (const service of asRecords(connections.services)) {
    const name = service.serviceId
    const status = service.connectionStatus
    if (typeof name !== 'string' || typeof status !== 'string') continue
    const setUp =
      service.source !== 'catalog' ||
      SET_UP_CATALOG_STATES.has(status) ||
      service.loginPending === true
    if (!setUp) continue
    const ids = serviceKernelIds(service, name)
    ids.forEach((id) => listed.add(id))
    const entry = ids.map((id) => kernel.get(id)).find((candidate) => candidate !== undefined)
    const hint = typeof service.setupHint === 'string' ? service.setupHint : undefined
    const configuredTools = typeof service.toolCount === 'number' ? service.toolCount : undefined
    const state =
      status === 'disabled'
        ? { state: 'disabled' as const }
        : entry?.tools !== undefined
          ? { state: 'connected' as const, toolCount: entry.tools }
          : entry?.error
            ? kernelState(entry.error, entry.stalled)
            : {
                ...configuredState(status, hint, kernelRunning),
                ...(configuredTools !== undefined ? { toolCount: configuredTools } : {})
              }
    servers.push({
      name,
      ...state,
      oauth: service.usesOauth === true,
      toggle: false,
      // The kernel lists every server the conversation runs; the rest have nothing to reconnect.
      ...(entry ? {} : { reconnectable: false as const })
    })
  }
  for (const [name, entry] of kernel) {
    if (listed.has(name)) continue
    servers.push({
      name,
      ...(entry.tools !== undefined
        ? { state: 'connected' as const, toolCount: entry.tools }
        : kernelState(entry.error ?? 'The server did not answer', entry.stalled)),
      oauth: false,
      toggle: false
    })
  }
  return { source: 'prime', servers, errors: [], live: kernelRunning }
}
