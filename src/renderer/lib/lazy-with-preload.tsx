import { lazy, useEffect, useState, type ComponentType } from 'react'

/**
 * A code-split component that can be shown without suspending. React.lazy suspends on its first render even when
 * the chunk is already loaded, and React holds a Suspense reveal back for 300 ms after a fallback shows, so a lazy
 * surface opened by a click appears 300+ ms late. Gate the surface on `useLoaded(wanted)` instead: it loads the
 * chunk when wanted and turns true once it is there, and from then on `Component` renders the loaded component
 * directly. Rendered earlier (or after a failed load) it is React.lazy, so keep it inside a <Suspense>.
 */
export function lazyWithPreload<Props extends object>(
  load: () => Promise<ComponentType<Props>>
): {
  Component: ComponentType<Props>
  useLoaded: (wanted: boolean) => boolean
  preload: () => Promise<ComponentType<Props>>
} {
  let loaded: ComponentType<Props> | undefined
  let loading: Promise<ComponentType<Props>> | undefined
  const preload = () =>
    (loading ??= load().then((component) => {
      loaded = component
      return component
    }))
  const Lazy = lazy(() => preload().then((component) => ({ default: component })))

  function Preloaded(props: Props) {
    // Chosen once per instance: switching from Lazy to the loaded component later would remount the subtree.
    const [Component] = useState<ComponentType<Props>>(() => loaded ?? Lazy)
    return <Component {...props} />
  }

  /** True once the chunk is loaded, or failed to (rendering then raises the error); loads it while `wanted`. */
  function useLoaded(wanted: boolean): boolean {
    const [settled, setSettled] = useState(() => loaded !== undefined)
    if (loaded !== undefined && !settled) {
      setSettled(true)
    }
    if (wanted && loaded === undefined) {
      void preload()
    }
    useEffect(() => {
      if (!wanted || settled || loaded !== undefined) return
      let current = true
      const settle = () => current && setSettled(true)
      preload().then(settle, settle)
      return () => {
        current = false
      }
    }, [wanted, settled])
    return settled || loaded !== undefined
  }

  return { Component: Preloaded, useLoaded, preload }
}
