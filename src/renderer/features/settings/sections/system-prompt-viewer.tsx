import { useEffect, useRef, useState } from 'react'
import { AlertCircle, BookOpen, Copy, Eye, RotateCcw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ENGINE_LABELS } from '@shared/api/engine'
import { useAgents } from '../../../store/agents'
import { useApp } from '../../../store/app'
import { samePath } from '../../../lib/paths'
import { Badge, Button, Dialog, Select, toast } from '../../../ui'
import { copyText } from '../../../ui/CopyButton'
import { agentOwnTitle, agentSessionFile } from '../../sessions/model'
import { settingsInvokeForFolder, invoke } from '../ipc'
import { Callout, Row } from '../layout'
import { useSettings } from '../store'

interface PromptView {
  title: string
  description: string
  text: string
  foundation: boolean
}

export function SystemPromptRows({
  onCustomize,
  canCustomize
}: {
  onCustomize: (text: string) => void
  canCustomize: boolean
}) {
  const engine = useSettings((state) => state.engine)
  const cwd = useApp((state) => state.prefs.activeWorkspace)
  const activeId = useAgents((state) => state.activeAgentId)
  const sessions = useAgents(
    useShallow((state) =>
      state.order
        .filter((agentId) => {
          const agent = state.agents[agentId]
          return agent && agent.info.engine === engine && !!cwd && samePath(agent.info.cwd, cwd)
        })
        .map((agentId) => {
          const agent = state.agents[agentId]!
          return JSON.stringify([
            agentId,
            agentOwnTitle(agent) || 'Untitled session',
            agent.status,
            agent.phase,
            !!agentSessionFile(agent),
            engine === 'prime'
              ? typeof agent.info.args.launch?.prime?.systemPrompt === 'string'
              : typeof agent.info.args.launch?.systemPrompt === 'string',
            engine === 'prime'
              ? !!agent.info.args.launch?.prime?.appendSystemPrompt?.length
              : !!agent.info.args.launch?.appendSystemPrompt?.length
          ])
        })
    )
  )
  const choices = sessions.map((entry) => {
    const [value, label, status, phase, saved, replacesPrompt, appendsPrompt] = JSON.parse(
      entry
    ) as [string, string, string, string, boolean, boolean, boolean]
    return { value, label, status, phase, saved, replacesPrompt, appendsPrompt }
  })
  const [selected, setSelected] = useState<string | undefined>()
  const sessionId = choices.some((choice) => choice.value === selected)
    ? selected
    : (choices.find((choice) => choice.value === activeId)?.value ?? choices[0]?.value)
  const session = choices.find((choice) => choice.value === sessionId)
  const [view, setView] = useState<PromptView | null>(null)
  const [loading, setLoading] = useState<'default' | 'session' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const readRevision = useRef(0)

  useEffect(
    () => () => {
      readRevision.current++
    },
    []
  )

  const read = async (foundation: boolean) => {
    const revision = ++readRevision.current
    setLoading(foundation ? 'default' : 'session')
    setError(null)
    try {
      let text: string
      if (foundation) {
        text = (await settingsInvokeForFolder(engine, cwd, 'settings:system-prompt-default')).text
      } else {
        if (!sessionId) return
        const result = await invoke('engine:bridge', sessionId, { op: 'system-prompt' }, undefined)
        if (!result || !('text' in result) || typeof result.text !== 'string')
          throw new Error('The engine did not return a system prompt.')
        text = result.text
      }
      if (readRevision.current !== revision) return
      setView({
        title: foundation
          ? `${ENGINE_LABELS[engine]} built-in foundation`
          : 'Current session prompt',
        description: foundation
          ? `${engine === 'prime' ? 'Bundled Engine 2 native foundation.' : 'Selected Engine native defaults with default tool rules.'} User files and session-specific additions are excluded. Runtime model and tool rules may differ.`
          : `${session?.label ?? 'Session'} · Read directly from ${ENGINE_LABELS[engine]}. A snapshot of its assembled prompt; hooks may change later requests.`,
        text,
        foundation
      })
    } catch (failure) {
      if (readRevision.current === revision)
        setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (readRevision.current === revision) setLoading(null)
    }
  }

  const apply = async () => {
    if (!restart) return
    setRestarting(true)
    setError(null)
    try {
      await useAgents.getState().restartAgent(restart)
      setRestart(null)
      toast({
        level: 'success',
        title: 'Session restarted',
        description: 'The engine has reloaded its saved instructions.'
      })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setRestart(null)
    } finally {
      setRestarting(false)
    }
  }

  return (
    <>
      <Row
        settingKey="instructions.builtIn"
        label="Built-in foundation"
        description="Read the engine’s native starting instructions, or use them as a draft for your own foundation."
      >
        <Button
          size="sm"
          variant="secondary"
          leading={<BookOpen />}
          loading={loading === 'default'}
          disabled={!!loading}
          onClick={() => void read(true)}
        >
          View default
        </Button>
      </Row>
      <Row
        settingKey="instructions.currentPrompt"
        label="Current session prompt"
        badges={<Badge>Read only</Badge>}
        description={
          session
            ? 'Inspect the assembled prompt reported by this open conversation.'
            : `Open an ${ENGINE_LABELS[engine]} session in this workspace to inspect its assembled prompt.`
        }
        below={
          session && (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Select
                aria-label="System prompt session"
                value={sessionId}
                onValueChange={setSelected}
                options={choices}
                disabled={!!loading || restarting}
                className="min-w-40 flex-1"
              />
              <Button
                size="sm"
                variant="secondary"
                leading={<Eye />}
                loading={loading === 'session'}
                disabled={
                  !!loading ||
                  session.status !== 'ready' ||
                  (engine === 'pi' && session.phase !== 'idle')
                }
                onClick={() => void read(false)}
              >
                View prompt
              </Button>
              <Button
                size="sm"
                variant="ghost"
                leading={<RotateCcw />}
                disabled={!session.saved || session.status !== 'ready' || session.phase !== 'idle'}
                onClick={() => sessionId && setRestart(sessionId)}
              >
                Restart to apply
              </Button>
            </div>
          )
        }
      />
      {session && engine === 'pi' && session.phase !== 'idle' && (
        <p className="px-4 pb-3 text-xs text-fg-3">
          The prompt is available when this session finishes its turn.
        </p>
      )}
      {session && (session.replacesPrompt || session.appendsPrompt) && (
        <p className="px-4 pb-3 text-xs leading-relaxed text-fg-3">
          This session has launch-time prompt instructions. They take precedence over the matching
          saved prompt files and remain in place after restart.
        </p>
      )}
      {session && !session.saved && (
        <p className="px-4 pb-3 text-xs leading-relaxed text-fg-3">
          Temporary sessions cannot restart in place. Start a new session to use saved instructions.
        </p>
      )}
      {error && (
        <div className="px-4 pb-3" role="alert">
          <Callout tone="danger" icon={<AlertCircle />} title="Prompt action failed">
            {error} Try the action again.
          </Callout>
        </div>
      )}
      <Dialog
        open={!!view}
        size="editor"
        icon={<BookOpen />}
        title={view?.title}
        description={view?.description}
        onOpenChange={(open) => !open && setView(null)}
        footerStart={
          <Button
            size="sm"
            variant="ghost"
            leading={<Copy />}
            onClick={() => {
              if (view)
                void copyText(view.text).then((copied) =>
                  toast(
                    copied
                      ? { level: 'success', title: 'Prompt copied' }
                      : {
                          level: 'error',
                          title: 'Could not copy prompt',
                          description: 'Select the text and copy it manually.'
                        }
                  )
                )
            }}
          >
            Copy
          </Button>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setView(null)}>
              Close
            </Button>
            {view?.foundation && (
              <Button
                variant="primary"
                disabled={!canCustomize}
                onClick={() => {
                  onCustomize(view.text)
                  setView(null)
                }}
              >
                Customize foundation
              </Button>
            )}
          </>
        }
      >
        <pre className="selectable max-h-[43vh] overflow-auto rounded-md bg-surface-1 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words text-fg-2 shadow-elev-0">
          {view?.text}
        </pre>
      </Dialog>
      <Dialog
        open={!!restart}
        size="confirm"
        icon={<RotateCcw />}
        title="Restart to apply saved instructions?"
        description={
          engine === 'prime'
            ? 'Engine 2 restarts its idle resident group and restores saved conversations. Busy work blocks this action.'
            : 'This saved conversation resumes after its engine restarts. Its launch-time prompt options remain in effect.'
        }
        onOpenChange={(open) => !restarting && !open && setRestart(null)}
        footer={
          <>
            <Button variant="ghost" disabled={restarting} onClick={() => setRestart(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={restarting} onClick={() => void apply()}>
              Restart session
            </Button>
          </>
        }
      />
    </>
  )
}
