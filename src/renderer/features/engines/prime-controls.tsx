import { Suspense, useEffect, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { create } from 'zustand'
import { lazyWithPreload } from '../../lib/lazy-with-preload'
import { useAgents } from '../../store/agents'
import { Button, Dialog, Tooltip } from '../../ui'
import { primeCommand, PrimeFeedback, usePrimeAction } from './prime-runtime'

export type PrimeControlSection =
  | 'goal'
  | 'autonomy'
  | 'schedule'
  | 'refine'
  | 'subagents'
  | 'factory'
  | 'context'
  | 'traces'
  | 'side-question'

interface PrimeControlsState {
  agentId: string | null
  section: PrimeControlSection
  initialText: string
  revision: number
}

const usePrimeControls = create<PrimeControlsState>(() => ({
  agentId: null,
  section: 'goal',
  initialText: '',
  revision: 0
}))

export function openPrimeControls(
  agentId: string,
  section: PrimeControlSection = 'goal',
  initialText = ''
): void {
  usePrimeControls.setState((state) => ({
    agentId,
    section,
    initialText,
    revision: state.revision + 1
  }))
}

function closePrimeControls(): void {
  usePrimeControls.setState({ agentId: null })
}

// The tabs load on the first open: only Engine 2 sessions show these controls (see lazyWithPreload).
const primeControlTabs = lazyWithPreload(() =>
  import('./prime-control-panels').then((m) => m.PrimeControlTabs)
)
const PrimeControlTabs = primeControlTabs.Component

export function PrimeControls({
  agentId,
  disabled = false
}: {
  agentId: string
  disabled?: boolean
}) {
  const state = usePrimeControls()
  const ephemeral = useAgents((store) => store.agents[agentId]?.info.args.noSession === true)
  const [confirmStop, setConfirmStop] = useState(false)
  const action = usePrimeAction()
  const requested = state.agentId === agentId
  // The dialog opens once its tabs are loaded (a few ms on the first open), fully rendered.
  const open = primeControlTabs.useLoaded(requested) && requested
  useEffect(() => {
    if (!open) setConfirmStop(false)
  }, [open])
  const stop = async () => {
    const stopped = await action.perform(() => primeCommand(agentId, 'kill', {}))
    if (stopped) closePrimeControls()
  }
  return (
    <>
      <Tooltip content="Engine 2 session controls">
        <Button
          size="xs"
          variant="ghost"
          aria-label="Controls"
          leading={<SlidersHorizontal />}
          disabled={disabled}
          onClick={() => openPrimeControls(agentId)}
          className="@max-[52em]/composer:w-6 @max-[52em]/composer:px-0"
        >
          <span className="@max-[52em]/composer:hidden">Controls</span>
        </Button>
      </Tooltip>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closePrimeControls()
        }}
        title="Engine 2 session controls"
        description="Goals, schedules and runtime controls for this session."
        icon={<SlidersHorizontal />}
        size="editor"
        bodyClassName="flex flex-col"
        footerStart={
          confirmStop ? (
            <span>
              {ephemeral
                ? 'Stops this temporary session and cancels its scheduled work.'
                : 'Stops this session and cancels its scheduled work. Saved history remains.'}
            </span>
          ) : (
            <span>
              {ephemeral
                ? 'Closing this tab stops the temporary session.'
                : 'Closing this tab keeps the session running.'}
            </span>
          )
        }
        footer={
          confirmStop ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
                Keep running
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={action.pending}
                onClick={() => void stop()}
              >
                Stop session
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmStop(true)}>
              Stop session…
            </Button>
          )
        }
      >
        {open && (
          <>
            <PrimeFeedback error={action.error} />
            <Suspense fallback={null}>
              <PrimeControlTabs
                key={state.revision}
                agentId={agentId}
                section={state.section}
                initialText={state.initialText}
                onSectionChange={(section) => usePrimeControls.setState({ section })}
                onInitialTextConsumed={() => usePrimeControls.setState({ initialText: '' })}
                onClose={closePrimeControls}
              />
            </Suspense>
          </>
        )}
      </Dialog>
    </>
  )
}
