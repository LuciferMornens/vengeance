import { useState } from 'react'
import { ArrowRightLeft, ChevronDown, Cpu, Settings, SquarePen } from 'lucide-react'
import { ENGINE_LABELS } from '@shared/api/engine'
import { cn } from '../../lib/cn'
import { useAgents } from '../../store/agents'
import { Button, Dialog, DropdownMenu, toast } from '../../ui'
import { prepareLaunch } from '../launch/spawn'
import { openSettingsSection } from '../palette/settings-sections'
import { agentOwnTitle } from '../sessions/model'
import { newSession } from '../shell/workspace'

/**
 * The trigger turns icon-only at the footer's first step (composer/footer.tsx). A running Engine 2 footer also
 * holds Controls and token speed beside Steer and Follow-up, so it compacts sooner, together with Controls
 * (prime-controls.tsx). Idle, it keeps the shared step.
 */
const COMPACT = {
  shared: {
    trigger:
      '@max-[52em]/composer:w-7 @max-[52em]/composer:justify-center @max-[52em]/composer:px-0',
    label: '@max-[52em]/composer:hidden'
  },
  primeRunning: {
    trigger:
      '@max-[62em]/composer:w-7 @max-[62em]/composer:justify-center @max-[62em]/composer:px-0',
    label: '@max-[62em]/composer:hidden'
  }
}

export function SessionEngineMenu({ agentId }: { agentId: string }) {
  const engine = useAgents((state) => state.agents[agentId]?.info.engine ?? 'pi')
  const status = useAgents((state) => state.agents[agentId]?.status)
  const phase = useAgents((state) => state.agents[agentId]?.phase)
  const compacting = useAgents((state) => !!state.agents[agentId]?.compaction)
  const modelChanging = useAgents((state) => !!state.agents[agentId]?.modelChangePending)
  const temporary = useAgents((state) => !!state.agents[agentId]?.info.args.noSession)
  const hasHistory = useAgents((state) => !!state.agents[agentId]?.entries.length)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const targetEngine = engine === 'pi' ? 'prime' : 'pi'
  const unavailableReason =
    temporary && hasHistory
      ? 'Temporary chats with messages cannot switch engines.'
      : status !== 'ready' || phase !== 'idle' || compacting || modelChanging
        ? 'Wait for this conversation to finish its current work.'
        : undefined
  const canSwitch = !unavailableReason
  const compact = engine === 'prime' && phase === 'running' ? COMPACT.primeRunning : COMPACT.shared

  async function switchEngine(): Promise<void> {
    const agent = useAgents.getState().agents[agentId]
    if (!agent || !canSwitch) return
    setConfirmOpen(false)
    setPreparing(true)
    try {
      const args = await prepareLaunch({
        engine: targetEngine,
        cwd: agent.info.cwd,
        name: agentOwnTitle(agent) ?? undefined
      })
      await useAgents.getState().switchEngine(agentId, args)
      toast({
        level: 'success',
        title: `This conversation now uses ${ENGINE_LABELS[targetEngine]}`
      })
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not switch engine',
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setPreparing(false)
    }
  }

  return (
    <>
      <DropdownMenu
        align="start"
        side="top"
        items={[
          { kind: 'label', label: `This conversation · ${ENGINE_LABELS[engine]}` },
          {
            label: `Switch to ${ENGINE_LABELS[targetEngine]}…`,
            icon: <ArrowRightLeft />,
            disabled: !canSwitch || preparing,
            onSelect: () => setConfirmOpen(true)
          },
          ...(unavailableReason ? [{ kind: 'label' as const, label: unavailableReason }] : []),
          { kind: 'separator' },
          { kind: 'label', label: 'Start a new conversation' },
          ...(['pi', 'prime'] as const).map((choice) => ({
            label: `New session with ${ENGINE_LABELS[choice]}`,
            icon: <SquarePen />,
            onSelect: () => {
              const cwd = useAgents.getState().agents[agentId]?.info.cwd
              if (cwd) void newSession({ cwd, engine: choice })
            }
          })),
          { kind: 'separator' },
          {
            label: `${ENGINE_LABELS[engine]} settings`,
            icon: <Settings />,
            onSelect: () => openSettingsSection('engine', engine)
          }
        ]}
        trigger={
          <button
            type="button"
            aria-label={`Conversation engine: ${ENGINE_LABELS[engine]}`}
            disabled={preparing || status === 'starting'}
            className={cn(
              'pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-fg-3 hover:bg-hover hover:text-fg-2 disabled:opacity-50',
              compact.trigger
            )}
          >
            <Cpu className="size-3.5 shrink-0" />
            <span className={compact.label}>
              {preparing ? 'Switching…' : ENGINE_LABELS[engine]}
            </span>
            <ChevronDown className={cn('size-3', compact.label)} />
          </button>
        }
      />
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Continue with ${ENGINE_LABELS[targetEngine]}?`}
        description="Switch the engine for this conversation and keep chatting here."
        icon={<ArrowRightLeft />}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSwitch} onClick={() => void switchEngine()}>
              Switch engine
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-ui leading-relaxed text-fg-2">
          <p>
            Your message history transfers, including tool results and attachments.
            {` ${ENGINE_LABELS[targetEngine]}`} uses its own model, settings and tools.
          </p>
          {engine === 'prime' && (
            <p>
              Engine 2 will stop after the transfer. Its goals, schedules and running child sessions
              do not transfer.
            </p>
          )}
          <p className="text-xs text-fg-3">
            {!temporary && <>A saved copy stays with {ENGINE_LABELS[engine]} for recovery. </>}
            The default for new sessions stays the same.
          </p>
        </div>
      </Dialog>
    </>
  )
}
