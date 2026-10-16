import { useEffect } from 'react'
import { invoke } from '../../lib/ipc'
import { useApp } from '../../store/app'

/**
 * Tell main the theme preference as soon as it changes, ahead of the resolved theme (AppShell's appearance effect
 * runs after this child effect): "System" must put the native theme back on 'system' before the renderer reads
 * prefers-color-scheme, or it reads the previously pinned theme.
 */
export function useThemePreferenceSync(): void {
  const preference = useApp((s) => s.prefs.theme)
  useEffect(() => {
    void invoke('win:set-theme-preference', preference)
  }, [preference])
}
