import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ProcessDoneEvent, ProcessLogEvent } from '@shared/api/settings'
import { locateEngine } from '../../engine/locate'
import { engineEnv, killProcessTree, OWN_PROCESS_GROUP } from '../../engine/runtime'
import { packageLabel } from './package-source'

/**
 * Run pi CLI subcommands (`install`, `remove`, `update`, `mcp`, `auth`, …) with the same runtime the
 * engine processes use. Output streams line-agnostically to the caller; the agent dir override in
 * `process.env.PI_CODING_AGENT_DIR` is inherited.
 */

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run to completion and capture output (short commands: `auth check`, `mcp list --json`, `--version`). */
export async function runPiCli(override: string | null, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  const location = await locateEngine(override)
  return new Promise((resolve) => {
    execFile(
      location.node.path,
      [location.cliPath, ...args],
      { cwd: options.cwd, env: engineEnv(location, { NO_COLOR: '1' }), windowsHide: true, timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

/**
 * N4: the friendly first line of a run's log ("Installing Web access…"). The UI never shows the raw
 * engine command; it travels in the event's `detail` field for diagnostics only.
 */
export function cliStatusLine(args: string[]): string {
  const [command, target] = args
  const subject = target && !target.startsWith('-') ? packageLabel(target) : null
  switch (command) {
    case 'install':
      return subject ? `Installing ${subject}…` : 'Installing…'
    case 'remove':
      return subject ? `Removing ${subject}…` : 'Removing…'
    case 'update':
      if (subject) return `Updating ${subject}…`
      if (args.includes('--self')) return 'Updating engine…'
      if (args.includes('--all')) return 'Updating engine and extensions…'
      if (args.includes('--extensions')) return 'Updating extensions…'
      if (args.includes('--models')) return 'Refreshing model catalogs…'
      return 'Updating…'
    case 'mcp': {
      const server = args[2]
      if (target === 'login') return server ? `Signing in to ${server}…` : 'Signing in…'
      if (target === 'logout') return server ? `Signing out of ${server}…` : 'Signing out…'
      return 'Running MCP command…'
    }
    default:
      return 'Running engine command…'
  }
}

function startEvent(runId: string, args: string[]): ProcessLogEvent {
  return { runId, stream: 'info', text: `${cliStatusLine(args)}\n`, detail: ['engine', ...args].join(' ') }
}

export interface StreamedRun {
  runId: string
  done: Promise<ProcessDoneEvent>
}

/** Cancel hooks of in-flight runs (real processes and mock simulations). */
const cancellers = new Map<string, () => void>()
/** When the last run ended: the OS can report its final file writes a moment after the process exits. */
let lastRunEndedAt = 0

/** Spawn a long-running pi subcommand and stream its output (colored, for the live log). */
export async function streamPiCli(
  override: string | null,
  args: string[],
  options: { cwd?: string; onLog: (event: ProcessLogEvent) => void; onDone: (event: ProcessDoneEvent) => void }
): Promise<StreamedRun> {
  const location = await locateEngine(override)
  const runId = randomUUID()
  const child = spawn(location.node.path, [location.cliPath, ...args], {
    cwd: options.cwd,
    env: engineEnv(location, { FORCE_COLOR: '1' }),
    windowsHide: true,
    detached: OWN_PROCESS_GROUP,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  cancellers.set(runId, () => killProcessTree(child))
  options.onLog(startEvent(runId, args))
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (text: string) => options.onLog({ runId, stream: 'stdout', text }))
  child.stderr?.on('data', (text: string) => options.onLog({ runId, stream: 'stderr', text }))
  const done = new Promise<ProcessDoneEvent>((resolve) => {
    let settled = false
    const finish = (event: ProcessDoneEvent) => {
      if (settled) return
      settled = true
      cancellers.delete(runId)
      lastRunEndedAt = Date.now()
      options.onDone(event)
      resolve(event)
    }
    child.once('error', (error) => finish({ runId, ok: false, code: null, error: error.message }))
    child.once('close', (code) => finish({ runId, ok: code === 0, code, error: code === 0 ? undefined : `Exited with code ${code ?? 'unknown'}` }))
  })
  return { runId, done }
}

export function cancelRun(runId: string): boolean {
  const cancel = cancellers.get(runId)
  if (!cancel) return false
  cancel()
  return true
}

/** Kill every in-flight install/update/MCP run (app quit). */
export function cancelAllRuns(): void {
  for (const cancel of [...cancellers.values()]) cancel()
}

/** True while any streamed CLI run is in flight (its file writes are not external changes). */
export function hasActiveRuns(): boolean {
  return cancellers.size > 0
}

/** True while a run is in flight or ended less than `withinMs` ago. */
export function hadRecentRun(withinMs: number): boolean {
  return hasActiveRuns() || Date.now() - lastRunEndedAt < withinMs
}

/**
 * Mock mode: replay a scripted CLI transcript with realistic pacing instead of touching the network.
 * `steps` are [delayMs, text] pairs; `onComplete` runs before the done event (e.g. to update settings).
 */
export function simulatePiCli(
  args: string[],
  steps: Array<[number, string]>,
  options: { onLog: (event: ProcessLogEvent) => void; onDone: (event: ProcessDoneEvent) => void; onComplete?: () => Promise<void> }
): StreamedRun {
  const runId = randomUUID()
  options.onLog(startEvent(runId, args))
  const done = new Promise<ProcessDoneEvent>((resolve) => {
    let index = 0
    let timer: NodeJS.Timeout | null = null
    const finish = (event: ProcessDoneEvent) => {
      cancellers.delete(runId)
      lastRunEndedAt = Date.now()
      options.onDone(event)
      resolve(event)
    }
    cancellers.set(runId, () => {
      if (timer) clearTimeout(timer)
      finish({ runId, ok: false, code: null, error: 'Cancelled' })
    })
    const next = () => {
      const step = steps[index++]
      if (!step) {
        void (options.onComplete?.() ?? Promise.resolve()).then(
          () => finish({ runId, ok: true, code: 0 }),
          (error: Error) => finish({ runId, ok: false, code: 1, error: error.message })
        )
        return
      }
      timer = setTimeout(() => {
        options.onLog({ runId, stream: 'stdout', text: step[1] })
        next()
      }, step[0])
    }
    next()
  })
  return { runId, done }
}
