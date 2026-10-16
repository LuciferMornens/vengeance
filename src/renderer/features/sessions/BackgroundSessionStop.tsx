import { useState } from 'react'
import { CircleStop } from 'lucide-react'
import type { BackgroundAgentInfo } from '@shared/api/engine'
import { invoke } from '../../lib/ipc'
import { Button, Dialog, IconButton, toast } from '../../ui'
import { useSessions } from './store'

export function BackgroundSessionStop({
  resident,
  title,
  className
}: {
  resident: BackgroundAgentInfo
  title: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function stop(): Promise<void> {
    setBusy(true)
    try {
      await invoke('engine:background-stop', resident.engine, {
        id: resident.id,
        sessionPath: resident.sessionPath
      })
      setOpen(false)
      await useSessions.getState().loadBackground()
    } catch (failure) {
      toast({
        level: 'error',
        title: 'Could not stop the session',
        description: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <IconButton
        label={`Stop session ${title}`}
        size="xs"
        className={className}
        onClick={() => setOpen(true)}
      >
        <CircleStop />
      </IconButton>
      {open && (
        <Dialog
          open
          onOpenChange={(next) => !busy && setOpen(next)}
          persistent={busy}
          size="confirm"
          icon={<CircleStop />}
          iconTone="warning"
          title="Stop this session?"
          description={`“${title}” will stop running and its scheduled work will be cancelled. Its saved conversation remains in your history.`}
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
                Keep running
              </Button>
              <Button variant="danger" loading={busy} onClick={() => void stop()}>
                Stop session
              </Button>
            </>
          }
        />
      )}
    </>
  )
}
