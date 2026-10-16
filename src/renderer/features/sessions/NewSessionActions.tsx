import { ChevronDown, Cpu, FileInput, Ghost, SlidersHorizontal, SquarePen } from 'lucide-react'
import { ENGINE_LABELS } from '@shared/api/engine'
import { useApp } from '../../store/app'
import { DropdownMenu, IconButton } from '../../ui'
import { openLaunchDialog } from '../launch'
import { newSession } from '../shell/workspace'
import { newEphemeralSession, pickImport } from './actions'

export function NewSessionActions() {
  const activeWorkspace = useApp((state) => state.prefs.activeWorkspace)
  return (
    <div className="flex items-center">
      <IconButton label="New session" hotkey="mod+n" size="sm" onClick={() => void newSession()}>
        <SquarePen />
      </IconButton>
      <DropdownMenu
        align="end"
        items={[
          { kind: 'label', label: 'Choose an engine' },
          ...(['pi', 'prime'] as const).map((engine) => ({
            label: `New session with ${ENGINE_LABELS[engine]}`,
            icon: <Cpu />,
            onSelect: () => void newSession({ engine })
          })),
          { kind: 'separator' },
          {
            label: 'New ephemeral session',
            icon: <Ghost />,
            onSelect: () => void newEphemeralSession()
          },
          {
            label: 'New session with options…',
            icon: <SlidersHorizontal />,
            disabled: !activeWorkspace,
            onSelect: () => activeWorkspace && openLaunchDialog('session', activeWorkspace)
          },
          { kind: 'separator' },
          { label: 'Import session…', icon: <FileInput />, onSelect: () => void pickImport() }
        ]}
        trigger={
          <IconButton label="More ways to start" size="xs" className="-ml-0.5 w-5">
            <ChevronDown />
          </IconButton>
        }
      />
    </div>
  )
}
