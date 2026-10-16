import { create } from 'zustand'
import type { RpcSlashCommand } from '@shared/engine-types'
import { useApp } from '../../store/app'

/** `args` asks for the arguments of `argsCommand` before running it. */
export type PalettePage = 'root' | 'models' | 'thinking' | 'args'

interface PaletteStore {
  page: PalettePage
  /** Search text to start the next page with (e.g. `/model son` → models page filtered by "son"). */
  initialQuery: string
  /** The extension command whose arguments the `args` page collects. */
  argsCommand: RpcSlashCommand | null
  setPage(page: PalettePage, initialQuery?: string): void
  /** Keyboard shortcut sheet. */
  shortcutsOpen: boolean
  setShortcutsOpen(open: boolean): void
}

export const usePalette = create<PaletteStore>()((set) => ({
  page: 'root',
  initialQuery: '',
  argsCommand: null,
  setPage: (page, initialQuery = '') => set({ page, initialQuery }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen })
}))

/** Open the command palette directly on a page (e.g. the model picker), optionally pre-filtered. */
export function openPalette(page: PalettePage = 'root', query = ''): void {
  usePalette.getState().setPage(page, query)
  useApp.getState().setPaletteOpen(true)
}

/** Ask for an extension command's arguments, then run it. */
export function openCommandArgs(command: RpcSlashCommand): void {
  usePalette.setState({ argsCommand: command })
  openPalette('args')
}

export function openShortcutsSheet(): void {
  useApp.getState().setPaletteOpen(false)
  usePalette.getState().setShortcutsOpen(true)
}

const RECENT_LIMIT = 6

export function paletteRecents(): string[] {
  return useApp.getState().prefs.features.composer?.paletteRecents ?? []
}

export function rememberPaletteItem(id: string): void {
  const prefs = useApp.getState().prefs.features.composer ?? {}
  const recents = [id, ...(prefs.paletteRecents ?? []).filter((r) => r !== id)].slice(0, RECENT_LIMIT)
  useApp.getState().updateFeaturePrefs('composer', { ...prefs, paletteRecents: recents })
}
