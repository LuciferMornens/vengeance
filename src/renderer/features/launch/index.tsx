import { Suspense, useEffect, useState } from 'react'
import { lazyWithPreload } from '../../lib/lazy-with-preload'
import { registerLaunchActions } from './actions'
import { useLaunch } from './store'

/**
 * Launch feature: project trust before spawning, per-workspace launch options, extension flags.
 *
 * Public surface:
 * - `<LaunchHost/>` (app root): Trust dialog + launch-options dialog, registers the palette actions
 *   `session.newWithOptions`, `workspace.launchOptions`, `workspace.trust`.
 * - `useEffectiveLaunch(agentId)`: read-only effective launch args of a running agent (inspector).
 * - `effectiveLaunchArgs(args)`, `formatEngineArgs(args)`: the same as pure helpers.
 * - `prepareLaunch` / `resolveSpawnTrust`: used by shell/workspace.ts `spawnAgent` for every spawn.
 */

// Both dialogs load on first use and show once their chunk is there (see lazyWithPreload).
const launchOptionsDialog = lazyWithPreload(() =>
  import('./LaunchOptionsDialog').then((m) => m.LaunchOptionsDialog)
)
const LaunchOptionsDialog = launchOptionsDialog.Component
const trustDialog = lazyWithPreload(() => import('./TrustDialog').then((m) => m.TrustDialog))
const TrustDialog = trustDialog.Component

/** The current value, or the last one while `open` is false, so a closing dialog keeps its content for the exit animation. */
function useLingering<T>(value: T | null | undefined): { last: T | null; open: boolean } {
  const [last, setLast] = useState<T | null>(value ?? null)
  if (value && value !== last) setLast(value)
  return { last: value ?? last, open: !!value }
}

export function LaunchHost() {
  const trust = useLingering(useLaunch((s) => s.trustQueue[0]))
  const pending = useLaunch((s) => s.trustQueue.length > 0)
  const options = useLingering(useLaunch((s) => s.dialog))
  const optionsLoaded = launchOptionsDialog.useLoaded(options.last !== null)
  const trustLoaded = trustDialog.useLoaded(trust.last !== null)
  useEffect(() => registerLaunchActions(), [])
  return (
    <Suspense fallback={null}>
      {options.last && optionsLoaded && (
        <LaunchOptionsDialog key={`${options.last.mode}:${options.last.cwd}`} state={options.last} open={options.open && !pending} />
      )}
      {trust.last && trustLoaded && <TrustDialog key={trust.last.id} request={trust.last} open={trust.open} />}
    </Suspense>
  )
}

export { useEffectiveLaunch, type EffectiveLaunch } from './useEffectiveLaunch'
export { effectiveLaunchArgs, formatEngineArgs } from './options'
export { prepareLaunch, resolveSpawnTrust, manageWorkspaceTrust } from './spawn'
export { openLaunchDialog } from './store'
