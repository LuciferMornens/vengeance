import { Blocks, Keyboard, RefreshCw, RotateCcw, UserRound } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { useApp } from '../../store/app'
import { useUpdates } from '../updates/store'
import { restartEngines } from './engines'

/** Palette actions owned by settings/updates (`settings.open` itself is a core action). */
registerActions([
  {
    id: 'settings.providers',
    title: 'Providers & accounts',
    group: 'Settings',
    keywords: ['sign in', 'login', 'api key', 'oauth', 'auth'],
    icon: UserRound,
    run: () => useApp.getState().openSettings('providers')
  },
  {
    id: 'settings.packages',
    title: 'Manage packages',
    group: 'Settings',
    keywords: ['install', 'extensions', 'npm', 'git'],
    icon: Blocks,
    run: () => useApp.getState().openSettings('packages')
  },
  {
    id: 'settings.shortcuts',
    title: 'Keyboard shortcuts',
    group: 'Settings',
    keywords: ['hotkeys', 'keys'],
    icon: Keyboard,
    run: () => useApp.getState().openSettings('shortcuts')
  },
  {
    id: 'settings.restart-engines',
    title: 'Restart engines',
    group: 'Settings',
    keywords: ['reload', 'apply settings'],
    icon: RotateCcw,
    run: restartEngines
  },
  {
    id: 'updates.check',
    title: 'Check for updates',
    group: 'Settings',
    keywords: ['update', 'upgrade', 'version'],
    icon: RefreshCw,
    run: async () => {
      useUpdates.getState().setSheetOpen(true)
      await useUpdates.getState().check()
    }
  }
])
