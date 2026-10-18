import { lazyWithPreload } from '../../lib/lazy-with-preload'

/** The settings sheet, code-split out of the main chunk; its own module so the sidebar can warm it without importing the shell. */
export const settingsSheet = lazyWithPreload(() => import('../settings').then((m) => m.SettingsSheet))

/** Start loading the sheet's chunk (hover/focus on its button); a failed load surfaces when the sheet opens. */
export function preloadSettingsSheet(): void {
  settingsSheet.preload().catch(() => undefined)
}
