import { useEffect } from 'react'
import { invoke } from '../../lib/ipc'
import { toast } from '../../ui'

/** After main reloaded the window because the renderer crashed, say so once, calmly. */
export function useRecoveryNotice(): void {
  useEffect(() => {
    void invoke('app:take-recovery-notice').then((recovered) => {
      if (recovered) toast({ level: 'info', title: 'Vengeance recovered from a display problem' })
    })
  }, [])
}
