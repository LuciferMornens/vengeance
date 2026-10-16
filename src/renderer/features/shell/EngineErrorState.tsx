import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { ChevronRight, Copy, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { invoke } from '../../lib/ipc'
import { spring } from '../../lib/motion'
import type { AgentState } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { Button, IconButton, toast } from '../../ui'
import { closeAgent } from '../sessions/actions'
import { agentSessionFile } from '../sessions/model'
import { PackageRecoveryActions } from '../settings/package-recovery'
import { friendlyEngineError } from './engine-error'

/** Recoverable error state for an engine process that crashed or failed to start. */
export function EngineErrorState({ agent }: { agent: AgentState }) {
  const restart = useAgents((s) => s.restartAgent)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  useEffect(() => {
    invoke('engine:stderr', agent.id)
      .then((text) => setLog(text.trim()))
      .catch(() => setLog(''))
  }, [agent.id, agent.status])

  // The card shows a friendly reason; the raw text lives here (stderr, or the error itself when pi never wrote any).
  const diagnostics = log === null ? '' : log || (agent.error ?? '')
  const tail = diagnostics.split('\n').slice(-60).join('\n')

  const restartEngine = async (): Promise<void> => {
    setBusy(true)
    try {
      await restart(agent.id)
    } catch (error) {
      toast({
        level: 'error',
        title: 'Restart failed',
        description: (error as Error).message
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <motion.div
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={spring.smooth}
        className="relative w-full max-w-[460px] overflow-hidden rounded-lg bg-surface-1 p-6 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-lg)]"
      >
        <div className="pointer-events-none absolute -top-24 -left-16 size-56 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--danger)_18%,transparent),transparent)]" />
        <div className="relative flex size-10 items-center justify-center rounded-card bg-danger-soft text-danger shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_25%,transparent)]">
          <TriangleAlert className="size-5" />
        </div>
        <div className="heading relative mt-4 text-lg font-semibold text-fg">
          The engine stopped
        </div>
        <p className="selectable relative mt-1.5 line-clamp-2 text-sm leading-relaxed break-words text-fg-2">
          {friendlyEngineError(agent.error)}
        </p>
        <p className="relative mt-1 text-xs text-fg-3">
          {agentSessionFile(agent)
            ? 'Your conversation is saved — restarting resumes it right where it stopped.'
            : 'Restarting starts a fresh engine for this workspace.'}
        </p>
        <div className="relative mt-5 flex gap-2">
          <Button
            variant="primary"
            loading={busy}
            leading={<RotateCcw />}
            onClick={() => void restartEngine()}
          >
            Restart engine
          </Button>
          <Button variant="ghost" leading={<X />} onClick={() => void closeAgent(agent.id)}>
            Close tab
          </Button>
        </div>
        <PackageRecoveryActions
          engine={agent.info.engine}
          cwd={agent.info.cwd}
          log={log ?? ''}
          onRemoved={() => void restartEngine()}
        />
        {diagnostics.length > 0 && (
          <div className="relative mt-5 border-t border-hairline-soft pt-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-expanded={showLog}
                onClick={() => setShowLog((v) => !v)}
                className="-ml-1.5 flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-fg-3 hover:bg-hover hover:text-fg-2"
              >
                <ChevronRight
                  className={cn('size-3.5 transition-transform', showLog && 'rotate-90')}
                />
                Diagnostics
              </button>
              <span className="flex-1" />
              {showLog && (
                <IconButton
                  label="Copy diagnostics"
                  size="xs"
                  onClick={() => void navigator.clipboard.writeText(diagnostics)}
                >
                  <Copy />
                </IconButton>
              )}
            </div>
            {showLog && (
              <pre className="selectable mt-1.5 max-h-56 overflow-auto rounded-md bg-[color-mix(in_oklab,var(--bg)_70%,transparent)] p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline-soft)]">
                {tail}
              </pre>
            )}
          </div>
        )}
      </motion.div>
    </div>
  )
}
