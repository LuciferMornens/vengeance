import { useEffect, useRef } from 'react'

const isMac = navigator.platform.toLowerCase().includes('mac')

/**
 * Combo syntax: `mod+k`, `mod+shift+p`, `alt+enter`, `escape`.
 * `mod` = Ctrl on Windows/Linux, Cmd on macOS.
 */
export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const wantMod = parts.includes('mod')
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (wantMod !== mod) return false
  if (!isMac && event.metaKey) return false
  if (parts.includes('shift') !== event.shiftKey || parts.includes('alt') !== event.altKey) return false
  const pressed = event.key.toLowerCase()
  return pressed === key || (key === 'comma' && pressed === ',') || (key === 'space' && pressed === ' ')
}

/** Marks an element that records a key combination: while it has focus, every key belongs to it. */
export const KEY_CAPTURE_ATTRIBUTE = 'data-key-capture'

export function isKeyCaptureTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${KEY_CAPTURE_ATTRIBUTE}]`) !== null
}

/**
 * Global (window-level, capture phase) hotkey, silent while a key capture has focus. Return false from the handler
 * to let the event through.
 */
export function useHotkey(combo: string, handler: (event: KeyboardEvent) => boolean | void, enabled = true): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!enabled) return
    const listener = (event: KeyboardEvent) => {
      if (isKeyCaptureTarget(event.target) || !matchesCombo(event, combo)) return
      if (ref.current(event) === false) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', listener, { capture: true })
    return () => window.removeEventListener('keydown', listener, { capture: true })
  }, [combo, enabled])
}

/** Key caps for a combo, e.g. `mod+k` → ['Ctrl', 'K']. */
export function comboLabel(combo: string): string[] {
  return combo.split('+').map((part) => {
    const k = part.toLowerCase()
    if (k === 'mod') return isMac ? '⌘' : 'Ctrl'
    if (k === 'shift') return isMac ? '⇧' : 'Shift'
    if (k === 'alt') return isMac ? '⌥' : 'Alt'
    if (k === 'enter') return 'Enter'
    if (k === 'escape') return 'Esc'
    if (k === 'comma') return ','
    return k.length === 1 ? k.toUpperCase() : k[0]!.toUpperCase() + k.slice(1)
  })
}
