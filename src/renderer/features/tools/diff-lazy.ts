import { useEffect, useState } from 'react'

/** The diff model (and the `diff` package behind it) is loaded on demand, off the startup path. */
type DiffModule = typeof import('./diff-model')

let loaded: DiffModule | null = null
let loading: Promise<DiffModule> | null = null

function loadDiffModule(): Promise<DiffModule> {
  loading ??= import('./diff-model').then((mod) => (loaded = mod))
  return loading
}

/** Warm the chunk once the app is idle so the first edit card renders its diff without a blank frame. */
export function preloadDiffModule(): void {
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500))
  idle(() => void loadDiffModule())
}

/** The diff module, or null for the first render(s) until its chunk has loaded. */
export function useDiffModule(): DiffModule | null {
  const [mod, setMod] = useState(loaded)
  useEffect(() => {
    if (!mod) void loadDiffModule().then(setMod)
  }, [mod])
  return mod
}
