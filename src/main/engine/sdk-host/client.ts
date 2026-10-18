import { HostProcess, spawnHost, type HostFailureTexts } from '../host-process'
import { locateEngine } from '../locate'
import type { SdkHostArgs, SdkHostConfig, SdkHostOp, SdkHostResult } from './protocol'

/**
 * The main process's side of the SDK host (`host.ts`). The host starts on the first call (or a prewarm) and exits
 * soon after its work: background calls nobody waits on (catalog refills, account models, package update checks)
 * keep it only briefly, Settings (its prewarm and section calls) for a minute. One host runs at a time, for the
 * engine the latest call asked for.
 */

/** How long a host stays up after background calls: long enough for a follow-up call of the same check. */
const BACKGROUND_IDLE_MS = 12_000
/** How long a host stays up after Settings opened or used it: long enough for a visit, short enough to free it. */
const INTERACTIVE_IDLE_MS = 60_000
/** Operations a Settings section waits on; the rest run in the background. */
const INTERACTIVE_OPS = new Set<SdkHostOp>(['packages', 'keybindings', 'context-files', 'warm'])
/** Longer than any engine operation takes (network checks time out after 10–15 s); only a hang reaches it. */
const CALL_TIMEOUT_MS = 120_000

const FAILURE_TEXTS: HostFailureTexts = {
  start: 'The Engine could not be started.',
  crashed: 'The Engine stopped unexpectedly.',
  cancelled: 'Cancelled: the Engine was restarted.',
  timedOut: 'The Engine took too long to answer.'
}

let host: HostProcess | null = null

async function startedHost(override: string | null): Promise<HostProcess> {
  const location = await locateEngine(override)
  if (host?.alive && host.key === location.packageDir) return host
  host?.dispose()
  const config: SdkHostConfig = { role: 'sdk', packageDir: location.packageDir }
  host = new HostProcess(
    location.packageDir,
    spawnHost(location, config),
    BACKGROUND_IDLE_MS,
    FAILURE_TEXTS,
    (exited, reason) => {
      if (host === exited) host = null
      // The next call starts a new host; a start failure or a crash still gets a line in the log.
      if (reason !== FAILURE_TEXTS.cancelled) console.error(`[vengeance] SDK host: ${reason}`)
    }
  )
  return host
}

/** Run one SDK operation of the engine `override` selects. */
export async function sdkHostCall<K extends SdkHostOp>(
  override: string | null,
  op: K,
  args: SdkHostArgs<K>
): Promise<SdkHostResult<K>> {
  const target = await startedHost(override)
  const keepAliveMs = INTERACTIVE_OPS.has(op) ? INTERACTIVE_IDLE_MS : BACKGROUND_IDLE_MS
  const call = target.call({ type: 'call', op, args }, { timeoutMs: CALL_TIMEOUT_MS, keepAliveMs })
  const reply = await call.done
  // SAFETY: protocol boundary — the host answers `op` with `SdkHostResult<op>` (host.ts).
  return reply as SdkHostResult<K>
}

/**
 * Settings is opening: start the host and load the modules its sections use, so their calls do not wait for the
 * SDK. Keeps the host for a Settings visit (INTERACTIVE_IDLE_MS); a warm host only gets that time extended.
 */
export function prewarmSdkHost(override: string | null): void {
  sdkHostCall(override, 'warm', {}).catch((error: Error) =>
    console.error(`[vengeance] SDK host not prewarmed: ${error.message}`)
  )
}

/** Settings closed: shorten the interactive keep-alive window so an idle host exits promptly. */
export function releaseSdkHost(): void {
  host?.trimIdle(1_500)
}

/** Stop the host (app quit). */
export function disposeSdkHost(): void {
  host?.dispose()
}
