import { appState } from '../app-state'
import { maskPrefs, resolvePrefsPatch } from '../features/launch/env-vault'
import { handle } from './handle'

/** App prefs; engine env values travel masked (N17, features/launch/env-vault.ts). */
export function registerAppIpc(): void {
  handle('app:get-state', () => maskPrefs(appState.getPrefs()))
  handle('app:set-state', (patch) => maskPrefs(appState.setPrefs(resolvePrefsPatch(patch, appState.getPrefs()))))
}
