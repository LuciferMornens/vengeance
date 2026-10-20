import { useEffect, useId, useRef, useState } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Copy,
  Eye,
  Info,
  ListPlus,
  Replace,
  RotateCcw,
  ScrollText,
  Trash2
} from 'lucide-react'
import {
  CONVERSATION_PROMPT_MAX_CHARS,
  ENGINE_LABELS,
  type ConversationPrompt,
  type EngineId
} from '@shared/api/engine'
import { bridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import type { AgentState } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { Badge, Button, Dialog, IconButton, SegmentedControl, Tooltip, toast } from '../../ui'
import { copyText } from '../../ui/CopyButton'
import { FOCUS_RING } from '../settings/controls'
import { Callout } from '../settings/layout'
import { agentTitle } from '../sessions/model'

/**
 * A conversation's own instructions (SPEC §3.6). Main keeps them per session file and applies them on every
 * spawn of that conversation, on top of the engine's own prompt assembly; this dialog edits them and applies
 * them through the guarded restart path. Opened from the session header, `/instructions` and the palette.
 */

type PromptMode = ConversationPrompt['mode']

interface DialogRequest {
  agentId: string
  /** Draft text supplied by `/instructions <text>`, added after any saved instructions. */
  text?: string
  revision: number
}

const useConversationPromptDialog = create<{ request: DialogRequest | null }>()(() => ({
  request: null
}))

let requestRevision = 0

export function openConversationPrompt(agentId: string, text?: string): void {
  useConversationPromptDialog.setState({
    request: { agentId, text, revision: ++requestRevision }
  })
}

/** Close the dialog, or only the request with `revision` when one is given. */
function closeDialog(revision?: number): void {
  useConversationPromptDialog.setState((state) =>
    revision === undefined || state.request?.revision === revision ? { request: null } : state
  )
}

const KEPT_SECTIONS: Record<EngineId, string> = {
  pi: 'The Engine still adds project context, skills, MCP servers and the working folder.',
  prime:
    'Engine 2 still adds project context, skills, MCP guidance, the date and the working folder.'
}

const APPEND_NOTE: Record<EngineId, string> = {
  pi: 'Added to the Engine’s instructions, after any APPEND_SYSTEM.md or launch-time additions.',
  prime:
    'Added at the end of Engine 2’s prompt, after any APPEND_SYSTEM.md or launch-time additions.'
}

/** What the engine's foundation contributes, and so what a replacement drops. */
const DROPPED_LAYERS: Record<EngineId, string> = {
  pi: 'The Engine drops its tool list, tool rules and docs sections.',
  prime: 'Engine 2 drops its core, usage, opinionated and per-model layers.'
}

const APPLY_NOTE: Record<EngineId, string> = {
  pi: 'Saving restarts this conversation’s engine, which applies them from its next turn.',
  prime: 'Saving restarts Engine 2 and every idle session running in it. Busy work blocks it.'
}

const MAX_LABEL = CONVERSATION_PROMPT_MAX_CHARS.toLocaleString()

/** Why the dialog cannot do something now. */
interface Hold {
  text: string
  /** It waits for the engine to run or for this conversation's work to end. */
  onEngine: boolean
}

/** Why this conversation cannot restart now, matching the refusals of the guarded restart path. */
function restartBlocker(agent: AgentState): Hold | undefined {
  if (agent.info.args.noSession && (agent.info.engine === 'prime' || agent.entries.length > 0)) {
    return {
      text:
        agent.info.engine === 'prime'
          ? 'Temporary Engine 2 chats cannot restart. Start a saved session to use instructions.'
          : 'Temporary chats with messages cannot restart. Start a saved session to use instructions.',
      onEngine: false
    }
  }
  if (agent.status === 'starting') return { text: 'Wait for the engine to start.', onEngine: true }
  if (agent.status !== 'ready') {
    return { text: 'The engine is not running. Restart it first.', onEngine: true }
  }
  if (
    agent.phase !== 'idle' ||
    agent.compaction ||
    agent.modelChangePending ||
    Object.values(agent.bash).some((run) => run.running)
  ) {
    return { text: 'Wait for this conversation to finish its current work.', onEngine: true }
  }
  if (agent.ext.dialogs.length > 0) {
    return { text: 'Answer the open extension dialog first.', onEngine: false }
  }
  return undefined
}

/** Why the engine cannot report this conversation's prompt now. */
function viewBlocker(agent: AgentState): Hold | undefined {
  if (agent.status !== 'ready') {
    return { text: 'The assembled prompt is available once the engine runs.', onEngine: true }
  }
  if (!agent.info.bridge) {
    return {
      text: `${ENGINE_LABELS[agent.info.engine]} cannot report its prompt in this session.`,
      onEngine: false
    }
  }
  if (agent.info.engine === 'pi' && agent.phase !== 'idle') {
    return { text: 'The assembled prompt is available when this turn finishes.', onEngine: true }
  }
  return undefined
}

/** The parts of an agent the dialog shows; plain values, so streaming does not re-render it. */
interface ConversationSnapshot {
  engine: EngineId
  title: string
  saved: ConversationPrompt | null
  blocker: string | undefined
  viewReason: string | undefined
  /**
   * Whether `blocker` already says why the prompt cannot be read: both wait for the engine to run or
   * for this conversation's work to end. A temporary chat's or an extension dialog's blocker does not.
   */
  blockerExplainsView: boolean
}

function useConversation(agentId: string): ConversationSnapshot | null {
  return useAgents(
    useShallow((state) => {
      const agent = state.agents[agentId]
      if (!agent) return null
      const blocker = restartBlocker(agent)
      const view = viewBlocker(agent)
      return {
        engine: agent.info.engine,
        title: agentTitle(agent),
        saved: agent.info.args.conversationPrompt ?? null,
        blocker: blocker?.text,
        viewReason: view?.text,
        blockerExplainsView: !!blocker?.onEngine && !!view?.onEngine
      }
    })
  )
}

function message(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

interface PromptView {
  text: string
  partial: boolean
}

/** The running prompt as the engine reports it, in a dialog above the instructions editor. */
function AssembledPromptDialog({
  conversation,
  view,
  dirty,
  onClose
}: {
  conversation: ConversationSnapshot
  view: PromptView | null
  dirty: boolean
  onClose: () => void
}) {
  // The Engine reports the prompt of the latest turn while nothing it can observe changed since.
  const timing =
    conversation.engine === 'pi' && view && !view.partial ? 'As of its latest turn' : 'A snapshot'
  return (
    <Dialog
      open={!!view}
      size="editor"
      icon={<BookOpen />}
      title="Assembled prompt"
      description={`${conversation.title} · Read from ${ENGINE_LABELS[conversation.engine]}. ${timing}; native hooks can change later requests.`}
      onOpenChange={(open) => !open && onClose()}
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
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {(view?.partial || dirty) && (
        <div className="mb-3 flex items-start gap-2.5 text-sm leading-relaxed text-fg-2 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-info">
          <Info />
          <p className="min-w-0 flex-1">
            {view?.partial &&
              'This is the base prompt: no turn ran since the Engine last opened this conversation (a restart opens it again), or its prompt, tools or MCP servers changed since the latest turn. Sections added when a turn starts, such as MCP servers, appear after the next turn. '}
            {dirty && 'Unsaved instructions are not included.'}
          </p>
        </div>
      )}
      <pre className="selectable max-h-[43vh] overflow-auto rounded-md bg-surface-1 p-4 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap text-fg-2 shadow-elev-0">
        {view?.text}
      </pre>
    </Dialog>
  )
}

type Pending = 'save' | 'remove' | 'restart'

const SUCCESS: Record<Pending, (engine: EngineId) => { title: string; description: string }> = {
  save: (engine) => ({
    title: 'Instructions saved',
    description:
      engine === 'prime'
        ? 'Engine 2 restarted with this conversation’s instructions.'
        : 'This conversation uses them from its next turn.'
  }),
  remove: () => ({
    title: 'Instructions removed',
    description: 'This conversation uses the engine’s own prompt again.'
  }),
  restart: () => ({
    title: 'Conversation restarted',
    description: 'It now uses your saved prompt files.'
  })
}

function ConversationPromptEditor({
  agentId,
  conversation,
  initialText
}: {
  agentId: string
  conversation: ConversationSnapshot
  initialText?: string
}) {
  const { engine, saved, blocker, viewReason, blockerExplainsView } = conversation
  const [mode, setMode] = useState<PromptMode>(saved?.mode ?? 'append')
  // Text from `/instructions <text>` follows the saved instructions in the draft: saving never drops
  // them unseen.
  const [text, setText] = useState(() =>
    saved && initialText
      ? `${saved.text.trimEnd()}\n\n${initialText}`
      : (initialText ?? saved?.text ?? '')
  )
  const [confirmation, setConfirmation] = useState<'discard' | 'remove' | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<{ title: string; detail: string } | null>(null)
  const [view, setView] = useState<PromptView | null>(null)
  const [reading, setReading] = useState(false)
  const viewReasonId = useId()
  const statusId = useId()
  const counterId = useId()
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  // A mode change alone counts only against saved instructions: an empty draft has nothing to lose.
  const dirty = text !== (saved?.text ?? '') || (!!saved && mode !== saved.mode)
  const tooLong = text.length > CONVERSATION_PROMPT_MAX_CHARS
  const canSave = dirty && !!text.trim() && !tooLong && !blocker && !pending
  // With a blocker, the reason the prompt cannot be read goes under the editor with it, unless the
  // blocker already says it: a note above would move the editor whenever a turn starts or ends.
  const viewNote = blocker ? undefined : viewReason
  const blockedViewNote = blocker && !blockerExplainsView ? viewReason : undefined

  const requestClose = () => {
    if (pending) return
    if (dirty) setConfirmation('discard')
    else closeDialog()
  }

  /** The guarded restart; without `prompt` the conversation keeps its saved instructions. */
  const restart = async (kind: Pending, prompt?: ConversationPrompt | null) => {
    setPending(kind)
    setError(null)
    try {
      await useAgents
        .getState()
        .restartAgent(agentId, prompt === undefined ? undefined : { conversationPrompt: prompt })
      closeDialog()
      toast({ level: 'success', ...SUCCESS[kind](engine) })
    } catch (failure) {
      if (!mounted.current) return
      setError({ title: 'Could not apply the change', detail: message(failure) })
      setConfirmation(null)
    } finally {
      if (mounted.current) setPending(null)
    }
  }

  const save = () => {
    if (canSave) void restart('save', { mode, text, updatedAt: Date.now() })
  }

  const readPrompt = async () => {
    setReading(true)
    setError(null)
    try {
      const result = await bridge.systemPrompt(agentId)
      if (typeof result?.text !== 'string') throw new Error('The engine did not return its prompt.')
      if (mounted.current) setView({ text: result.text, partial: result.partial === true })
    } catch (failure) {
      if (mounted.current)
        setError({ title: 'Could not read the prompt', detail: message(failure) })
    } finally {
      if (mounted.current) setReading(false)
    }
  }

  const startActions = !confirmation && (saved || !dirty)

  return (
    <Dialog
      open
      persistent
      size="editor"
      icon={<ScrollText />}
      title="Conversation instructions"
      description={`${conversation.title} · ${ENGINE_LABELS[engine]}`}
      onOpenChange={(open) => !open && requestClose()}
      hint={confirmation ? undefined : { combo: 'mod+enter', label: 'to save and restart' }}
      onKeyDown={(event) => {
        // The assembled prompt dialog is a React child: its keys bubble here.
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !confirmation && !view) {
          event.preventDefault()
          save()
        }
      }}
      footerStart={
        startActions ? (
          <>
            {saved && (
              <Button
                size="sm"
                variant="ghost"
                leading={<Trash2 />}
                disabled={!!blocker || !!pending}
                onClick={() => setConfirmation('remove')}
              >
                Remove
              </Button>
            )}
            {!dirty && (
              <Tooltip content="Apply prompt files saved since this conversation started">
                <span>
                  <Button
                    size="sm"
                    variant="ghost"
                    leading={<RotateCcw />}
                    loading={pending === 'restart'}
                    disabled={!!blocker || !!pending}
                    onClick={() => void restart('restart')}
                  >
                    Restart
                  </Button>
                </span>
              </Tooltip>
            )}
          </>
        ) : undefined
      }
      footer={
        confirmation ? (
          <>
            <Button variant="ghost" disabled={!!pending} onClick={() => setConfirmation(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              loading={pending === 'remove'}
              disabled={confirmation === 'remove' && !!blocker}
              onClick={() =>
                confirmation === 'discard' ? closeDialog() : void restart('remove', null)
              }
            >
              {confirmation === 'discard' ? 'Discard changes' : 'Remove and restart'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={!!pending} onClick={requestClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending === 'save'}
              disabled={!canSave}
              onClick={save}
            >
              Save and restart
            </Button>
          </>
        )
      }
    >
      <p className="mb-3 text-sm leading-relaxed text-fg-2">
        Only this conversation uses these instructions. {KEPT_SECTIONS[engine]}
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label="Instruction mode"
          value={mode}
          onValueChange={setMode}
          segments={[
            {
              value: 'append',
              label: 'Add to engine prompt',
              icon: <ListPlus />,
              disabled: !!pending
            },
            {
              value: 'replace',
              label: 'Replace foundation',
              icon: <Replace />,
              disabled: !!pending
            }
          ]}
        />
        {dirty && <Badge>Unsaved</Badge>}
        <Tooltip content="Read the prompt this conversation runs with">
          <span className="ml-auto">
            <Button
              size="sm"
              variant="ghost"
              leading={<Eye />}
              loading={reading}
              disabled={!!viewReason || reading}
              aria-describedby={viewReason ? (viewNote ? viewReasonId : statusId) : undefined}
              onClick={() => void readPrompt()}
            >
              View assembled prompt
            </Button>
          </span>
        </Tooltip>
        {/* Visible, not a tooltip: a disabled button cannot take focus to show one. */}
        {viewNote && (
          <p id={viewReasonId} className="basis-full text-right text-xs leading-relaxed text-fg-3">
            {viewNote}
          </p>
        )}
      </div>
      {mode === 'replace' ? (
        <Callout tone="warning" icon={<AlertTriangle />} title="Replaces the foundation">
          {DROPPED_LAYERS[engine]} SYSTEM.md and launch-time replacements stop applying;
          APPEND_SYSTEM.md still applies.
        </Callout>
      ) : (
        <p className="mb-3 text-sm leading-relaxed text-fg-3">{APPEND_NOTE[engine]}</p>
      )}
      {confirmation && (
        <div role="alert">
          <Callout
            tone="warning"
            icon={<AlertTriangle />}
            title={confirmation === 'discard' ? 'Discard changes?' : 'Remove these instructions?'}
          >
            {confirmation === 'remove'
              ? 'The conversation restarts with the engine’s own prompt and saved prompt files.'
              : saved
                ? 'Your unsaved changes will be lost. The saved instructions stay as they are.'
                : 'Your unsaved instructions will be lost.'}
          </Callout>
        </div>
      )}
      {error && (
        <div role="alert">
          <Callout tone="danger" icon={<AlertCircle />} title={error.title}>
            {error.detail}
          </Callout>
        </div>
      )}
      <textarea
        aria-label="Conversation instructions"
        aria-invalid={tooLong || undefined}
        aria-describedby={`${statusId} ${counterId}`}
        value={text}
        disabled={!!pending}
        spellCheck={false}
        placeholder={
          mode === 'replace'
            ? 'Write the complete foundation this conversation should use…'
            : 'Add instructions for this conversation…'
        }
        onChange={(event) => setText(event.target.value)}
        className={cn(
          'selectable w-full resize-none rounded-md bg-surface-1 px-4 py-3 font-mono text-sm leading-relaxed text-fg placeholder:text-fg-3',
          confirmation || error || mode === 'replace'
            ? 'h-[min(220px,24vh)]'
            : 'h-[min(300px,32vh)]',
          'shadow-elev-0 outline-none aria-[invalid=true]:shadow-[0_0_0_1px_var(--danger-border)]',
          FOCUS_RING
        )}
      />
      <div className="mt-2 flex items-start gap-3 text-xs leading-relaxed text-fg-3">
        <p id={statusId} className={cn('min-w-0 flex-1', blocker && !pending && 'text-warning')}>
          {blocker && !pending ? (
            <>
              {blocker}
              {blockedViewNote && <span className="block text-fg-3">{blockedViewNote}</span>}
            </>
          ) : tooLong ? (
            `Keep instructions under ${MAX_LABEL} characters.`
          ) : saved && !text.trim() ? (
            'Write instructions, or remove them to use the engine’s own prompt.'
          ) : (
            APPLY_NOTE[engine]
          )}
        </p>
        <span id={counterId} className={cn('shrink-0 tabular', tooLong && 'text-danger')}>
          {text.length.toLocaleString()} / {MAX_LABEL}
        </span>
      </div>
      <AssembledPromptDialog
        conversation={conversation}
        view={view}
        dirty={dirty}
        onClose={() => setView(null)}
      />
    </Dialog>
  )
}

function OpenConversationPrompt({ agentId, text }: { agentId: string; text?: string }) {
  const conversation = useConversation(agentId)
  return conversation ? (
    <ConversationPromptEditor agentId={agentId} conversation={conversation} initialText={text} />
  ) : null
}

/**
 * Mounted once by the shell, outside the session pane: the dialog stays with its conversation, draft and
 * any error, while another session comes to the front or this one's engine crashes. Closing the
 * conversation closes it.
 */
export function ConversationPromptDialog() {
  const request = useConversationPromptDialog((state) => state.request)
  const open = useAgents((state) => !!request && !!state.agents[request.agentId])
  useEffect(() => {
    if (request && !open) closeDialog(request.revision)
  }, [request, open])
  return request && open ? (
    <OpenConversationPrompt key={request.revision} agentId={request.agentId} text={request.text} />
  ) : null
}

/** Header control: an icon while the conversation has no instructions, a highlighted chip with them. */
export function ConversationPromptButton({ agentId }: { agentId: string }) {
  const mode = useAgents((state) => state.agents[agentId]?.info.args.conversationPrompt?.mode)
  if (!mode) {
    return (
      <IconButton
        label="Conversation instructions…"
        onClick={() => openConversationPrompt(agentId)}
      >
        <ScrollText />
      </IconButton>
    )
  }
  const label = mode === 'replace' ? 'Custom foundation' : 'Instructions'
  return (
    <Tooltip
      content={
        mode === 'replace'
          ? 'Conversation instructions · Replace the foundation'
          : 'Conversation instructions · Added to the engine prompt'
      }
    >
      <button
        type="button"
        aria-label={`Conversation instructions: ${label}`}
        data-conversation-prompt={mode}
        onClick={() => openConversationPrompt(agentId)}
        className="no-drag pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-softer px-2 text-xs font-medium whitespace-nowrap text-accent-text transition-colors duration-[var(--dur-instant)] hover:bg-accent-soft"
      >
        <ScrollText className="size-3.5 shrink-0" />
        <span className="@max-[640px]/pane:hidden">{label}</span>
      </button>
    </Tooltip>
  )
}
