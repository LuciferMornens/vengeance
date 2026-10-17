import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PlatformInfo } from '@shared/api/app'

type Os = PlatformInfo['os']

/** The window's OS (preload bridge), read when called so the pure helpers below also load in plain-Node checks. */
function hostOs(): Os {
  return window.vengeance.platform.os
}

/** The `+` key (pi syntax `ctrl++`) leaves two empty parts at the end of a plain split. */
function comboParts(combo: string): string[] {
  if (combo === '+') return ['+']
  return combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
}

/** Characters of physical keys (`KeyboardEvent.code`) for layouts and modifiers that change `event.key`. */
const CODE_CHARACTERS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
}

/** The US-layout character of a physical key: `KeyK` → `k`, `Digit1` → `1`, `Comma` → `,`. */
export function keyFromCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return CODE_CHARACTERS[code]
}

/**
 * Whether `event.key` names no ASCII key: a dead key, or a character composed by Option on macOS (⌥P is `π`) or typed
 * on a non-Latin layout (Ctrl+K is `л` on Russian). Shortcuts then follow the physical key; Latin layouts (AZERTY,
 * Dvorak) keep matching by character.
 */
export function composedKey(key: string): boolean {
  return key === 'Dead' || /^[^\x20-\x7e]$/u.test(key)
}

/**
 * Combo syntax: `mod+k`, `mod+shift+p`, `alt+enter`, `escape`.
 * `mod` = Ctrl on Windows/Linux, Cmd on macOS; `ctrl` and `super` (Cmd, Win) name those keys themselves.
 */
export function matchesCombo(event: KeyboardEvent, combo: string, os: Os = hostOs()): boolean {
  const parts = comboParts(combo.toLowerCase())
  const key = parts[parts.length - 1]
  const mac = os === 'darwin'
  const wantMod = parts.includes('mod')
  const wantCtrl = parts.includes('ctrl') || (wantMod && !mac)
  const wantMeta = parts.includes('super') || (wantMod && mac)
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta) return false
  if (parts.includes('shift') !== event.shiftKey || parts.includes('alt') !== event.altKey)
    return false
  const pressed = ((composedKey(event.key) && keyFromCode(event.code)) || event.key).toLowerCase()
  return (
    pressed === key || (key === 'comma' && pressed === ',') || (key === 'space' && pressed === ' ')
  )
}

/** `mod+enter` in a field's own keydown handler (submit a multi-line form), whatever else is held. */
export function isModEnter(event: KeyboardEvent | ReactKeyboardEvent, os: Os = hostOs()): boolean {
  return event.key === 'Enter' && (os === 'darwin' ? event.metaKey : event.ctrlKey)
}

/** Deletes the focused item (a session row): Delete, and ⌘⌫ on macOS, where most keyboards have no forward delete. */
export function isDeleteItemKey(
  event: KeyboardEvent | ReactKeyboardEvent,
  os: Os = hostOs()
): boolean {
  if (event.key === 'Delete') return true
  return (
    os === 'darwin' &&
    event.key === 'Backspace' &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

/** The combo menus show for isDeleteItemKey. */
export function deleteItemCombo(os: Os = hostOs()): string {
  return os === 'darwin' ? 'mod+backspace' : 'delete'
}

/** Renames the focused item (a session row): F2. Return opens rows, on macOS too (no Finder-style Return rename). */
export function isRenameItemKey(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return event.key === 'F2'
}

/** The combo menus show for isRenameItemKey: none on macOS, where F2 is a brightness key unless fn is held. */
export function renameItemCombo(os: Os = hostOs()): string | undefined {
  return os === 'darwin' ? undefined : 'f2'
}

/**
 * The key belongs to an input method composition (Japanese, Chinese, Korean, dead-key sequences): Enter confirms the
 * candidate, it does not submit. Chromium reports `isComposing`, some Linux IMEs only keyCode 229.
 */
export function isImeComposing(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing || native.keyCode === 229
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
export function useHotkey(
  combo: string,
  handler: (event: KeyboardEvent) => boolean | void,
  enabled = true
): void {
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

const MODIFIERS = new Set(['mod', 'ctrl', 'alt', 'shift', 'super'])
/** macOS menus list modifiers as ⌃⌥⇧⌘ whatever order a combo names them in. */
const MAC_MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'mod', 'super']

const MAC_CAPS: Record<string, string> = {
  mod: '⌘',
  super: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  enter: '↩',
  return: '↩',
  backspace: '⌫',
  delete: '⌦',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→'
}
/** macOS key names in running text, where Apple spells keys out: "⇧Return", "⌘Delete". */
const MAC_WORDS: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  backspace: 'Delete',
  delete: 'Forward Delete',
  tab: 'Tab'
}
const PC_CAPS: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', enter: 'Enter' }
const SHARED_CAPS: Record<string, string> = { escape: 'Esc', esc: 'Esc', comma: ',' }

function capName(part: string, os: Os, words: boolean): string {
  const k = part.toLowerCase()
  const named = os === 'darwin' ? ((words ? MAC_WORDS[k] : undefined) ?? MAC_CAPS[k]) : PC_CAPS[k]
  const name = named ?? SHARED_CAPS[k]
  if (name) return name
  return k.length <= 1 ? k.toUpperCase() : k[0]!.toUpperCase() + k.slice(1)
}

/** A combo's parts in display order: as written on Windows/Linux, modifiers first in Apple's order on macOS. */
function displayParts(combo: string, os: Os): string[] {
  const parts = comboParts(combo)
  if (os !== 'darwin') return parts
  const rank = (part: string) => {
    const index = MAC_MODIFIER_ORDER.indexOf(part.toLowerCase())
    return index < 0 ? MAC_MODIFIER_ORDER.length : index
  }
  return [...parts].sort((a, b) => rank(a) - rank(b))
}

/** Key caps for a combo: `mod+shift+p` → ['Ctrl', 'Shift', 'P'] on Windows/Linux, ['⇧', '⌘', 'P'] on macOS. */
export function shortcutCaps(combo: string, os: Os = hostOs()): string[] {
  return displayParts(combo, os).map((part) => capName(part, os, false))
}

/**
 * A combo as running text for titles and sentences: `Ctrl+Shift+P` on Windows/Linux, `⇧⌘P` on macOS (modifier
 * glyphs, keys spelled out: `⌥Return`).
 */
export function shortcutText(combo: string, os: Os = hostOs()): string {
  const parts = displayParts(combo, os)
  if (os !== 'darwin') return parts.map((part) => capName(part, os, false)).join('+')
  return parts.map((part) => capName(part, os, !MODIFIERS.has(part.toLowerCase()))).join('')
}

/** Words people type when looking for a key, besides its caps and text: "cmd", "option", "control", "return". */
const SEARCH_ALIASES: Record<Os, Record<string, string>> = {
  darwin: {
    mod: 'cmd command',
    super: 'cmd command',
    alt: 'option opt alt',
    ctrl: 'control ctrl',
    enter: 'return enter',
    backspace: 'delete backspace'
  },
  win32: { mod: 'control', ctrl: 'control', super: 'win windows' },
  linux: { mod: 'control', ctrl: 'control', super: 'meta' }
}

/**
 * Whether a shortcut (a combo, or steps like `escape escape`) matches a lowercase search: by its raw combo, its
 * caps and text on this OS, or the usual names of its keys.
 */
export function shortcutMatches(keys: string, needle: string, os: Os = hostOs()): boolean {
  const steps = keys.split(' ')
  const words = steps.flatMap((step) => [
    step,
    shortcutText(step, os),
    ...shortcutCaps(step, os),
    ...comboParts(step).map((part) => SEARCH_ALIASES[os][part.toLowerCase()] ?? '')
  ])
  return words.join(' ').toLowerCase().includes(needle)
}
