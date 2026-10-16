import { useEffect, useState } from 'react'
import { RefreshCw, Send, Square, Trash2 } from 'lucide-react'
import { Badge, Button, Checkbox, IconButton, Skeleton, Textarea } from '../../ui'
import { NumberField } from '../settings/controls'
import {
  nativeNumber,
  nativeRecord,
  nativeRows,
  nativeText,
  primeCommand,
  PrimeFeedback,
  usePrimeAction,
  usePrimeQuery
} from './prime-runtime'

interface NativeChild {
  id: string
  activeSessionId: string
  label: string
  status: string
  model: string
  answer: string
  error: string
}

function readChildren(value: unknown): NativeChild[] {
  return nativeRows(nativeRecord(value).children)
    .map((child) => ({
      id: nativeText(child.id),
      activeSessionId: nativeText(child.activeSessionId),
      label: nativeText(child.label) || nativeText(child.sessionName) || nativeText(child.id),
      status: nativeText(child.status),
      model: nativeText(child.model),
      answer: nativeText(child.answerPreview),
      error: nativeText(child.error)
    }))
    .filter((child) => child.id.length > 0)
}

export function PrimeSubagents({ agentId }: { agentId: string }) {
  const roster = usePrimeQuery(agentId, 'get_rlm_children')
  const depthQuery = usePrimeQuery(agentId, 'get_rlm_max_depth_status')
  const action = usePrimeAction()
  const [depthDraft, setDepthDraft] = useState<{ value: number | undefined } | null>(null)
  const [global, setGlobal] = useState(false)
  const [messageTarget, setMessageTarget] = useState<NativeChild | null>(null)
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const children = readChildren(roster.data)
  const depthState = nativeRecord(depthQuery.data)
  const currentDepth =
    nativeNumber(depthState.maxDepth) ?? nativeNumber(depthState.effectiveMaxDepth)
  const depth = depthDraft?.value
  const depthReady = depthDraft !== null

  useEffect(() => {
    if (currentDepth !== undefined) {
      setDepthDraft((draft) => draft ?? { value: currentDepth })
    }
  }, [currentDepth])

  const changeDepth = async () => {
    if (!depthReady || depth === undefined) return
    await action.perform(async () => {
      const result = nativeRecord(
        await primeCommand(agentId, 'set_rlm_max_depth', { maxDepth: depth, global })
      )
      if (global && result.globalSaved === false) {
        throw new Error(
          'Session depth was changed, but this engine could not save the global default.'
        )
      }
      await depthQuery.reload()
    }, 'Subagent depth saved.')
  }

  const cancelChild = async (child: NativeChild) => {
    await action.perform(async () => {
      const result = nativeRecord(
        await primeCommand(agentId, 'cancel_rlm_child', { childId: child.id })
      )
      if (result.cancelled === false)
        throw new Error('This delegated task has already finished. Refresh the list.')
      await roster.reload()
    }, 'Subagent stopped.')
  }

  const deleteChild = async (child: NativeChild) => {
    const deleted = await action.perform(async () => {
      const result = nativeRecord(
        await primeCommand(agentId, 'delete_rlm_subagent', { childId: child.id })
      )
      if (result.deleted !== true) {
        throw new Error(
          result.reason === 'running'
            ? 'Stop this subagent before deleting it.'
            : 'The engine could not find this subagent. Refresh the list.'
        )
      }
      await roster.reload()
    }, 'Subagent deleted.')
    if (deleted) setRemoving(null)
  }

  const sendMessage = async () => {
    if (!messageTarget?.activeSessionId || !message.trim()) return
    const sent = await action.perform(
      () =>
        primeCommand(agentId, 'send_message', {
          targetActiveSessionId: messageTarget.activeSessionId,
          message: message.trim()
        }),
      'Message sent to the subagent.'
    )
    if (sent) {
      setMessage('')
      setMessageTarget(null)
    }
  }

  return (
    <div className="space-y-5 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Delegated sessions stay with this resident session. Review their results, send instructions,
        or stop a running child.
      </p>
      <PrimeFeedback
        error={action.error ?? roster.error ?? depthQuery.error}
        notice={action.notice}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-fg">Maximum delegation depth</h3>
          {nativeText(depthState.source) && (
            <p className="mt-1 text-xs text-fg-3">Source: {nativeText(depthState.source)}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <NumberField
            aria-label="Maximum delegation depth"
            value={depth}
            min={0}
            integer
            disabled={!depthReady || action.pending}
            onCommit={(value) => setDepthDraft({ value })}
          />
          <Button
            size="sm"
            disabled={!depthReady || depth === undefined}
            loading={action.pending}
            onClick={() => void changeDepth()}
          >
            Apply
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-fg-2">
        <Checkbox checked={global} disabled={action.pending} onCheckedChange={setGlobal} />
        Also save as the default for new sessions
      </label>
      <section className="border-t border-hairline-soft pt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-fg">Subagents</h3>
          <IconButton
            label="Refresh subagents"
            disabled={action.pending}
            onClick={() => void roster.reload()}
          >
            <RefreshCw />
          </IconButton>
        </div>
        {roster.loading && roster.data === null && <Skeleton className="h-20 w-full" />}
        {!roster.loading && !roster.error && children.length === 0 && (
          <p className="py-3 text-sm text-fg-3">
            Delegated tasks will appear here when the engine creates subagents.
          </p>
        )}
        {children.map((child) => {
          const running = child.status === 'running' || child.status === 'queued'
          return (
            <div
              key={child.id}
              className="space-y-3 border-b border-hairline-soft py-4 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-words text-sm font-medium text-fg">{child.label}</span>
                    <Badge>{child.status || 'Unknown'}</Badge>
                  </div>
                  {child.model && <p className="mt-1 text-xs text-fg-3">{child.model}</p>}
                  {child.answer && (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg-2">
                      {child.answer}
                    </p>
                  )}
                  {child.error && <p className="mt-2 text-sm text-danger">{child.error}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    label={`Message ${child.label}`}
                    disabled={!child.activeSessionId || action.pending}
                    onClick={() => {
                      setMessageTarget(child)
                      setMessage('')
                    }}
                  >
                    <Send />
                  </IconButton>
                  {running ? (
                    <IconButton
                      label={`Stop ${child.label}`}
                      disabled={action.pending}
                      onClick={() => void cancelChild(child)}
                    >
                      <Square />
                    </IconButton>
                  ) : (
                    <IconButton
                      label={`Delete ${child.label}`}
                      disabled={action.pending}
                      onClick={() => setRemoving(child.id)}
                    >
                      <Trash2 />
                    </IconButton>
                  )}
                </div>
              </div>
              {removing === child.id && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-fg-2">
                    Delete this subagent and stop any ongoing conversation?
                  </span>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={action.pending}
                    onClick={() => void deleteChild(child)}
                  >
                    Delete
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>
                    Keep
                  </Button>
                </div>
              )}
              {messageTarget?.id === child.id && (
                <div className="space-y-2">
                  <Textarea
                    aria-label={`Message to ${child.label}`}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Give this subagent a follow-up instruction…"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      loading={action.pending}
                      disabled={!message.trim()}
                      onClick={() => void sendMessage()}
                    >
                      Send message
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setMessageTarget(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
