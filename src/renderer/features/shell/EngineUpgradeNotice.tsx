import { useState } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { useAgents } from '../../store/agents'
import { Button, toast } from '../../ui'
import { agentSessionFile } from '../sessions/model'

export function EngineUpgradeNotice({ agentId }: { agentId: string }) {
  const version = useAgents((state) => state.agents[agentId]?.info.runtime?.version)
  const selectedVersion = useAgents((state) => state.agents[agentId]?.info.runtime?.selectedVersion)
  const ready = useAgents((state) => state.agents[agentId]?.status === 'ready')
  const saved = useAgents((state) => {
    const agent = state.agents[agentId]
    return !!agent && !!agentSessionFile(agent)
  })
  const running = useAgents((state) => {
    const agent = state.agents[agentId]
    return (
      !!agent &&
      (agent.phase !== 'idle' ||
        !!agent.compaction ||
        Object.values(agent.bash).some((run) => run.running))
    )
  })
  const [restarting, setRestarting] = useState(false)
  if (!version || !selectedVersion || version === selectedVersion) return null

  const restart = async (): Promise<void> => {
    setRestarting(true)
    try {
      await useAgents.getState().restartAgent(agentId)
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not restart session',
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div
      data-engine-upgrade
      role="status"
      className={
        'relative z-10 flex shrink-0 items-start gap-3 border-b border-hairline-soft ' +
        'bg-warning-soft px-5 py-3'
      }
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_20rem]">
          <p className="text-ui font-medium break-words text-fg">
            This session is using a different Engine 2 version
          </p>
          <p className="mt-0.5 text-xs break-words text-fg-2">
            Running {version} · Selected {selectedVersion}
          </p>
          <p className="mt-1 text-xs leading-relaxed break-words text-fg-2">
            {saved
              ? 'Restart keeps saved history. Shared sessions must all be idle.'
              : 'Use a new session for the selected Engine. Temporary sessions cannot restart.'}
          </p>
        </div>
        {saved && (
          <Button
            size="sm"
            variant="outline"
            className="mt-0.5"
            disabled={!ready || running}
            loading={restarting}
            leading={<RotateCcw />}
            onClick={() => void restart()}
          >
            Restart session
          </Button>
        )}
      </div>
    </div>
  )
}
