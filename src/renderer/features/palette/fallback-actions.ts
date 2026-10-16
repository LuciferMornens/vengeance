import { useEffect } from 'react'
import { registerActions, useActions, type AppAction } from '../../lib/actions'

/**
 * Register actions only while no other feature provides the same id. Lanes that own an action (e.g. the
 * settings lane's `settings.shortcuts`) win regardless of mount order; ours fill the gap until then.
 * `list` must be a stable (module-level) array.
 */
export function useFallbackActions(list: AppAction[]): void {
  const registered = useActions()
  const missing = list.filter((action) => !registered.some((other) => other.id === action.id && other !== action))
  const key = missing.map((action) => action.id).join('|')
  useEffect(() => {
    const own = list.filter((action) => key.split('|').includes(action.id))
    return own.length > 0 ? registerActions(own) : undefined
  }, [key, list])
}
