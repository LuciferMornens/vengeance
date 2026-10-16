import { useSyncExternalStore } from 'react'
import { on } from './ipc'

let focused = false
const listeners = new Set<() => void>()

on('win:focus-changed', ({ focused: next }) => {
  focused = next
  for (const listener of listeners) listener()
})

// While the page is still loading the document reports no focus even in a focused window, and main's focus event may
// have fired before this page listened: until a component subscribes, the document's own answer is the truth.
function snapshot(): boolean {
  return listeners.size === 0 ? document.hasFocus() : focused
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) focused = document.hasFocus()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Whether the app window has focus, from main's BrowserWindow focus/blur (`win:focus-changed`). Decorative loops
 * (the placeholder rotation, background polling) run only while it is true, so a window in the background stays
 * idle; minimizing blurs the window too.
 */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, snapshot)
}
