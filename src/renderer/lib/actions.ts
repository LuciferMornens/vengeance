import { useSyncExternalStore } from 'react'
import type { LucideIcon } from 'lucide-react'

/**
 * App-level action registry. Features register actions from their own modules (collision-free);
 * the command palette lists them and the shell binds global hotkeys for core ones.
 */
export interface AppAction {
  id: string
  title: string
  /** Palette group, e.g. "General", "Session", "View". */
  group: string
  keywords?: string[]
  /** Display-only hotkey hint (bind it yourself with useHotkey). */
  hotkey?: string
  icon?: LucideIcon
  /** Hidden from the palette when it returns false. */
  when?: () => boolean
  run: () => void | Promise<void>
}

const actions = new Map<string, AppAction>()
const listeners = new Set<() => void>()
let snapshot: AppAction[] = []

function changed(): void {
  snapshot = [...actions.values()]
  for (const listener of listeners) listener()
}

/** Register actions; returns an unregister function. Re-registering an id replaces it. */
export function registerActions(list: AppAction[]): () => void {
  for (const action of list) actions.set(action.id, action)
  changed()
  return () => {
    for (const action of list) if (actions.get(action.id) === action) actions.delete(action.id)
    changed()
  }
}

export function hasAction(id: string): boolean {
  return actions.has(id)
}

export function runAction(id: string): void {
  void actions.get(id)?.run()
}

export function useActions(): AppAction[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot
  )
}
