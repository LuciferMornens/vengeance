import { useEffect, type ReactNode } from 'react'
import { create } from 'zustand'
import { FolderOpen, Info } from 'lucide-react'
import { basename, formatCost, formatTokens, pluralize } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { REVEAL_LABEL } from '../../lib/platform-copy'
import { useAgents } from '../../store/agents'
import { Button, Dialog } from '../../ui'
import { CopyButton } from '../../ui/CopyButton'
import { providerLabel } from '../chat/ModelPicker'
import { agentTitle } from '../sessions/model'
import { THINKING_LABELS } from './thinking-pill'

/** `/session`: session information and statistics (slash-commands.md), in a dialog over the session. */

const useSessionInfo = create<{ agentId: string | null }>()(() => ({ agentId: null }))

export function openSessionInfo(agentId: string): void {
  useSessionInfo.setState({ agentId })
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-4 border-b border-hairline-soft py-1.5 last:border-b-0">
      <span className="w-28 shrink-0 text-sm text-fg-3">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-right text-ui text-fg">{children}</div>
    </div>
  )
}

function Mono({ text, label }: { text: string; label: string }) {
  return (
    <>
      {/* rtl + an ltr run: long paths lose their start, not the file name. */}
      <span className="selectable min-w-0 truncate font-mono text-xs text-fg-2 [direction:rtl]" title={text}>
        <span dir="ltr">{text}</span>
      </span>
      <CopyButton value={text} label={`Copy ${label.toLowerCase()}`} />
    </>
  )
}

export function SessionInfoDialog() {
  const agentId = useSessionInfo((s) => s.agentId)
  const agent = useAgents((s) => (agentId ? s.agents[agentId] : undefined))

  useEffect(() => {
    if (agentId) void useAgents.getState().refreshStats(agentId)
  }, [agentId])

  const close = () => useSessionInfo.setState({ agentId: null })
  const stats = agent?.stats
  const session = agent?.session
  const file = session?.sessionFile ?? stats?.sessionFile
  const usage = stats?.contextUsage

  return (
    <Dialog
      open={!!agent}
      onOpenChange={(open) => !open && close()}
      size="form"
      icon={<Info />}
      title={agent ? agentTitle(agent) : 'Session'}
      description={agent ? `Session in ${basename(agent.info.cwd)}` : undefined}
      footer={
        <>
          {file && (
            <Button variant="ghost" size="sm" leading={<FolderOpen />} onClick={() => void invoke('sys:reveal', file)}>
              {REVEAL_LABEL}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      {agent && (
        <div className="flex flex-col pb-1">
          <Row label="Workspace">
            <Mono text={agent.info.cwd} label="Folder" />
          </Row>
          <Row label="Session file">{file ? <Mono text={file} label="Path" /> : <span className="text-fg-3">Not saved (ephemeral)</span>}</Row>
          {session && (
            <Row label="Session ID">
              <Mono text={session.sessionId} label="ID" />
            </Row>
          )}
          <Row label="Model">
            <span className="truncate">{agent.model?.name ?? '—'}</span>
            {agent.model && <span className="shrink-0 text-sm text-fg-3">{providerLabel(agent.model.provider)}</span>}
          </Row>
          <Row label="Thinking">{agent.thinkingLevel ? THINKING_LABELS[agent.thinkingLevel] : '—'}</Row>
          {stats && (
            <>
              <Row label="Messages">
                <span className="tabular">
                  {stats.userMessages} user · {stats.assistantMessages} assistant · {pluralize(stats.toolCalls, 'tool call')}
                </span>
              </Row>
              <Row label="Tokens">
                <span className="tabular">
                  {formatTokens(stats.tokens.input)} in · {formatTokens(stats.tokens.output)} out
                  {stats.tokens.cacheRead + stats.tokens.cacheWrite > 0 && <span className="text-fg-3"> · {formatTokens(stats.tokens.cacheRead)} cached</span>}
                </span>
              </Row>
              {usage && (
                <Row label="Context">
                  <span className="tabular">
                    {usage.tokens === null ? '—' : formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}
                    {usage.percent !== null && <span className="text-fg-3"> · {Math.round(usage.percent)}%</span>}
                  </span>
                </Row>
              )}
              <Row label="Cost">
                <span className="tabular">{formatCost(stats.cost)}</span>
              </Row>
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}
