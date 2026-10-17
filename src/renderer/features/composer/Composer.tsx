import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ImagePlus } from 'lucide-react'
import { ENGINE_LABELS } from '@shared/api/engine'
import { runAction } from '../../lib/actions'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import { invoke, platform } from '../../lib/ipc'
import { isImeComposing, shortcutText } from '../../lib/keybindings'
import { spring } from '../../lib/motion'
import { useAgents } from '../../store/agents'
import { Kbd, Spinner, toast } from '../../ui'
import { RetryNotice } from '../chat/notices'
import { ExtensionStatusChips, ExtensionWidgets } from '../extension-ui'
import { getEffectiveSetting } from '../settings/effective'
import { FleetPill } from '../subagents'
import { TodoDock } from '../tools'
import { supportsEngineCommand, useEngineCapabilities } from '../engines/registry'
import { findBuiltin, isBuiltinAvailable, matchBuiltin } from './builtins'
import { useComposerAttachments } from './attachments'
import { useCommandHints } from './command-hints'
import { promptHistory, pushHistory, useDraft, useDrafts, type DraftPatch } from './drafts'
import { RotatingPlaceholder } from './editor-hints'
import { ComposerFooter } from './footer'
import { cycleThinkingLevel, stopAgent } from './operations'
import { AttachmentTray, BashRunningRow, QueueChips, type QueuedItem } from './parts'
import {
  drainQueue,
  queuedImageCount,
  rememberQueued,
  requeue,
  toImageContent,
  type QueuedMessage
} from './queue'
import { SessionInfoDialog } from './session-info'
import { SuggestionMenu } from './SuggestionMenu'
import {
  mentionText,
  useFileMentions,
  useOfferedCommands,
  useSlashSuggestions,
  type MentionSuggestion,
  type SlashSuggestion
} from './suggestions'

const LINE_H = 22
const PAD_Y = 14
const MIN_H = LINE_H + PAD_Y
const MAX_H = LINE_H * 12 + PAD_Y
const ESC_WINDOW_MS = 1400

const IDLE_HINTS = [
  'Ask anything about this project…',
  'Type / for commands, prompts and skills',
  'Mention a file with @',
  'Run a shell command with ! (!! keeps it out of context)',
  'Paste or drop images and files',
  `${shortcutText('shift+enter')} for a new line`
]

type Trigger =
  { kind: 'slash'; query: string } | { kind: 'mention'; query: string; start: number } | null

/** Which suggestion menu (if any) the text around the caret asks for. */
function detectTrigger(text: string, caret: number): Trigger {
  if (text.startsWith('/')) {
    const firstSpace = text.search(/\s/)
    if (firstSpace === -1 || caret <= firstSpace)
      return { kind: 'slash', query: text.slice(1, firstSpace === -1 ? text.length : firstSpace) }
  }
  const match = /(?:^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret))
  if (match) return { kind: 'mention', query: match[1]!, start: caret - match[1]!.length - 1 }
  return null
}

/** `/name ` with nothing typed after it yet: the command whose argument hint to ghost after the caret. */
const ARGS_START = /^\/([\w:-]+) $/

/** `<required>` arguments: Enter completes the command instead of running it. */
const needsArgs = (hint: string | undefined) => !!hint && hint.trimStart().startsWith('<')

type EscIntent = 'stop' | 'tree' | 'fork'

const ESC_LABEL: Record<EscIntent, string> = {
  stop: 'to stop',
  tree: 'to open the session tree',
  fork: 'to fork from a message'
}

const EMPTY_COMMANDS: never[] = []

export function Composer({ agentId }: { agentId: string }) {
  const draft = useDraft(agentId)
  const patchDraft = useCallback(
    (patch: DraftPatch) => useDrafts.getState().patch(agentId, patch),
    [agentId]
  )
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const compacting = useAgents((state) => !!state.agents[agentId]?.compaction)
  const ready = useAgents((s) => s.agents[agentId]?.status === 'ready')
  const queue = useAgents((s) => s.agents[agentId]?.queue)
  const commands = useAgents((s) => s.agents[agentId]?.commands ?? EMPTY_COMMANDS)
  const cwd = useAgents((s) => s.agents[agentId]?.info.cwd ?? '')
  const engine = useAgents((s) => s.agents[agentId]?.info.engine ?? 'pi')
  const bridge = useAgents((s) => s.agents[agentId]?.info.bridge === true)
  const capabilities = useEngineCapabilities(engine)
  const model = useAgents((s) => s.agents[agentId]?.model)
  const editorText = useAgents((s) => s.agents[agentId]?.ext.editorText)
  const bashRuns = useAgents((s) => s.agents[agentId]?.bash)
  const focusRequest = useDrafts((s) => s.focusRequest)

  const rootRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const historyStash = useRef('')
  const escArmedAt = useRef(0)
  const [caret, setCaret] = useState(0)
  const [height, setHeight] = useState(MIN_H)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [escArmed, setEscArmed] = useState<EscIntent | null>(null)

  const text = draft.text
  const runningBash = useMemo(
    () => Object.values(bashRuns ?? {}).find((run) => run.running),
    [bashRuns]
  )

  // ─── Suggestion menus ──────────────────────────────────────────────────────
  const hints = useCommandHints(cwd, commands)
  const trigger = useMemo(() => detectTrigger(text, caret), [text, caret])
  const menuOpen = !compacting && trigger !== null && dismissedAt !== text
  const offeredCommands = useOfferedCommands(commands, cwd || null, engine)
  const slashItems = useSlashSuggestions(
    offeredCommands,
    trigger?.kind === 'slash' ? trigger.query : '',
    hints,
    engine,
    bridge
  )
  const mentions = useFileMentions(
    cwd,
    trigger?.kind === 'mention' ? trigger.query : '',
    menuOpen && trigger?.kind === 'mention'
  )
  const items: Array<SlashSuggestion | MentionSuggestion> = !menuOpen
    ? []
    : trigger.kind === 'slash'
      ? slashItems
      : mentions.items
  const triggerKey = trigger ? `${trigger.kind}:${trigger.query}` : ''

  useEffect(() => setActive(0), [triggerKey])

  /** Argument hint of a command name: engine commands shadow built-ins of the same name. */
  const hintFor = useCallback(
    (name: string) =>
      commands.some((c) => c.name === name) ? hints.get(name) : findBuiltin(name, engine)?.args,
    [commands, hints, engine]
  )
  const argsName = ARGS_START.exec(text)?.[1]
  const ghostHint = argsName && caret === text.length ? hintFor(argsName) : undefined

  // ─── Text + caret plumbing ─────────────────────────────────────────────────
  const setText = useCallback(
    (value: string, caretAt?: number) => {
      patchDraft({ text: value })
      pendingCaret.current = caretAt ?? value.length
    },
    [patchDraft]
  )

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current)
      setCaret(pendingCaret.current)
      pendingCaret.current = null
    }
  })

  // Auto-grow: measure an invisible twin so the visible textarea can animate its height.
  useLayoutEffect(() => {
    const mirror = mirrorRef.current
    if (!mirror) return
    setHeight(Math.min(MAX_H, Math.max(MIN_H, mirror.scrollHeight)))
  }, [text])

  // Publish the docked composer's height on the session pane (`--composer-h`): the transcript padding, the
  // jump pill and the toasts follow it.
  useLayoutEffect(() => {
    const el = rootRef.current
    const pane = el?.closest<HTMLElement>('[data-session-pane]')
    if (!el || !pane) return
    const observer = new ResizeObserver(() =>
      pane.style.setProperty('--composer-h', `${el.offsetHeight}px`)
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      pane.style.removeProperty('--composer-h')
    }
  }, [])

  const focus = useCallback(() => textareaRef.current?.focus(), [])
  useEffect(() => {
    focus()
    setHistoryIndex(null)
    setDismissedAt(null)
  }, [agentId, focus])
  useEffect(() => {
    // Only the active session's composer answers (a pane fading out after a switch is still mounted).
    if (focusRequest && useAgents.getState().activeAgentId === agentId) focus()
  }, [focusRequest, focus, agentId])

  // set_editor_text from extensions (and edit & resend) replaces the draft text.
  useEffect(() => {
    if (!editorText || editorText.nonce <= useDrafts.getState().draftOf(agentId).editorNonce) return
    patchDraft({ text: editorText.text, editorNonce: editorText.nonce })
    pendingCaret.current = editorText.text.length
    focus()
  }, [editorText, agentId, patchDraft, focus])

  const insertAtCaret = useCallback(
    (snippet: string) => {
      const el = textareaRef.current
      const current = useDrafts.getState().draftOf(agentId).text
      const start = el?.selectionStart ?? current.length
      const end = el?.selectionEnd ?? current.length
      const before = current.slice(0, start)
      const lead = before && !/\s$/.test(before) ? ' ' : ''
      const value = `${before}${lead}${snippet}${current.slice(end)}`
      setText(value, start + lead.length + snippet.length)
      focus()
    },
    [agentId, setText, focus]
  )

  const { dragging, onPaste, pickAttachments } = useComposerAttachments({
    cwd,
    patchDraft,
    insertAtCaret
  })

  // ─── Sending ───────────────────────────────────────────────────────────────
  const submit = async (mode: 'steer' | 'followUp', override?: string) => {
    const current = useDrafts.getState().draftOf(agentId)
    const value = (override ?? current.text).trim()
    const images = override === undefined ? current.images : []
    if (!ready || (!value && images.length === 0)) return
    if (useAgents.getState().agents[agentId]?.compaction) return
    if (current.pending.length > 0 && override === undefined) {
      toast({ level: 'info', title: 'Still preparing images…', duration: 1800 })
      return
    }
    setHistoryIndex(null)
    setDismissedAt(null)

    const builtin = matchBuiltin(value, engine)
    if (builtin && !commands.some((c) => c.name === builtin.command.name)) {
      if (!isBuiltinAvailable(builtin.command, engine)) {
        toast({
          level: 'info',
          title: `/${builtin.command.name} is unavailable in ${ENGINE_LABELS[engine]}`
        })
        return
      }
      if (override === undefined) useDrafts.getState().clear(agentId)
      pushHistory(value)
      await builtin.command.run(agentId, builtin.args)
      return
    }

    if (value.startsWith('!')) {
      if (!supportsEngineCommand(engine, 'bash')) {
        toast({
          level: 'info',
          title: `Shell commands are unavailable in ${ENGINE_LABELS[engine]}`
        })
        return
      }
      const excludeFromContext = value.startsWith('!!')
      const command = value.slice(excludeFromContext ? 2 : 1).trim()
      if (!command) return
      useDrafts.getState().clear(agentId)
      pushHistory(value)
      try {
        await useAgents.getState().runBash(agentId, command, excludeFromContext)
      } catch (error) {
        toast({
          level: 'error',
          title: 'Command failed to start',
          description: (error as Error).message
        })
      }
      return
    }

    const queuing = useAgents.getState().agents[agentId]?.phase === 'running'
    const command = queuing ? (mode === 'steer' ? 'steer' : 'follow_up') : 'prompt'
    if (!supportsEngineCommand(engine, command)) {
      toast({ level: 'info', title: `This message cannot be sent to ${ENGINE_LABELS[engine]} yet` })
      return
    }
    if (override === undefined) useDrafts.getState().clear(agentId)
    pushHistory(value)
    try {
      await useAgents.getState().prompt(agentId, value, {
        images: images.length ? images.map(toImageContent) : undefined,
        whileRunning: mode
      })
      if (queuing)
        rememberQueued(agentId, {
          kind: mode === 'steer' ? 'steering' : 'followUp',
          text: value,
          images
        })
    } catch (error) {
      if (override === undefined)
        patchDraft((d) => (d.text ? {} : { text: current.text, images: current.images }))
      toast({ level: 'error', title: 'Could not send', description: (error as Error).message })
    }
  }

  /** Put queued messages (text and images) back into the editor, before whatever is being typed. */
  const restoreIntoEditor = (messages: QueuedMessage[]) => {
    if (messages.length === 0) return
    const current = useDrafts.getState().draftOf(agentId)
    setText([...messages.map((m) => m.text), current.text].filter((t) => t.trim()).join('\n\n'))
    patchDraft({ images: [...messages.flatMap((m) => m.images), ...current.images] })
    focus()
  }

  const restoreQueue = async () => restoreIntoEditor(await drainQueue(agentId))

  /**
   * Engine 2 addresses native queue previews atomically. Engine restores the remaining cleared
   * messages in order, or returns them to the editor if the agent settles meanwhile.
   */
  const removeQueued = async (item: QueuedItem) => {
    try {
      if (engine === 'prime') {
        const result = (await invoke('prime:command', agentId, 'mutate_queued_message', {
          lane: item.kind,
          index: item.index,
          expectedText: item.text,
          mutation: { type: 'delete' }
        })) as { status?: string }
        if (result.status !== 'applied') {
          throw new Error('The queue changed before this message could be removed. Try again.')
        }
        return
      }
      const all = await drainQueue(agentId)
      const sameKind = all.filter((m) => m.kind === item.kind)
      const target =
        sameKind[item.index]?.text === item.text
          ? sameKind[item.index]
          : sameKind.find((m) => m.text === item.text)
      restoreIntoEditor(
        await requeue(
          agentId,
          all.filter((m) => m !== target)
        )
      )
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not update the queue',
        description: (error as Error).message
      })
    }
  }

  // ─── Suggestions: pick ─────────────────────────────────────────────────────
  const pick = (index: number, mode: 'run' | 'complete') => {
    const item = items[index]
    if (!item || !trigger) return
    if (trigger.kind === 'mention') {
      const path = (item as MentionSuggestion).path
      const snippet = `${mentionText(path)} `
      const value = text.slice(0, trigger.start) + snippet + text.slice(caret)
      setText(value, trigger.start + snippet.length)
      return
    }
    const slash = item as SlashSuggestion
    const firstSpace = text.search(/\s/)
    const rest = firstSpace === -1 ? '' : text.slice(firstSpace).replace(/^\s+/, '')
    if (mode === 'complete' || rest || needsArgs(slash.hint)) {
      const head = `/${slash.name} `
      setText(head + rest, head.length)
      return
    }
    void submit('steer', `/${slash.name}`)
    useDrafts.getState().clear(agentId)
  }

  // ─── Escape twice: stop a run, or the doubleEscapeAction setting on an empty idle editor ──────
  const armEscape = (intent: EscIntent): boolean => {
    if (escArmed === intent && Date.now() - escArmedAt.current < ESC_WINDOW_MS) {
      escArmedAt.current = 0
      setEscArmed(null)
      return true
    }
    escArmedAt.current = Date.now()
    setEscArmed(intent)
    setTimeout(() => {
      if (Date.now() - escArmedAt.current >= ESC_WINDOW_MS) setEscArmed(null)
    }, ESC_WINDOW_MS)
    return false
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event)) return
    const el = event.currentTarget

    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (items.length === 0) return
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + delta + items.length) % items.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey && !event.altKey) || event.key === 'Tab') {
        if (items.length > 0) {
          event.preventDefault()
          pick(active, event.key === 'Tab' || trigger?.kind === 'mention' ? 'complete' : 'run')
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedAt(text)
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit(event.altKey ? 'followUp' : 'steer')
      return
    }

    if (event.key === 'Escape' && (running || compacting || runningBash)) {
      event.preventDefault()
      if (armEscape('stop')) void stopAgent(agentId)
      return
    }

    if (event.key === 'Escape' && text === '' && draft.images.length === 0) {
      const setting = getEffectiveSetting('doubleEscapeAction', cwd || null, engine)
      if (setting === 'tree' || setting === 'fork') {
        event.preventDefault()
        if (armEscape(setting)) runAction(setting === 'tree' ? 'session.tree' : 'session.fork')
      }
      return
    }

    // On macOS ⌥↑ also moves the caret to the start of the paragraph, so there it restores only a non-empty queue.
    if (
      event.key === 'ArrowUp' &&
      event.altKey &&
      (platform.os !== 'darwin' || queue?.steering.length || queue?.followUp.length) &&
      supportsEngineCommand(engine, 'clear_queue')
    ) {
      event.preventDefault()
      void restoreQueue()
      return
    }

    if (
      event.key === 'Tab' &&
      event.shiftKey &&
      supportsEngineCommand(engine, 'cycle_thinking_level')
    ) {
      event.preventDefault()
      void cycleThinkingLevel(agentId)
      return
    }

    if (
      event.key === 'ArrowUp' &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const onFirstLine = !text.slice(0, el.selectionStart).includes('\n')
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0
      if (
        (historyIndex === null && text === '' && atStart) ||
        (historyIndex !== null && onFirstLine)
      ) {
        const history = promptHistory()
        if (history.length === 0) return
        event.preventDefault()
        if (historyIndex === null) historyStash.current = text
        const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(next)
        setText(history[next]!)
      }
      return
    }

    if (
      event.key === 'ArrowDown' &&
      historyIndex !== null &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const onLastLine = !text.slice(el.selectionEnd).includes('\n')
      if (!onLastLine) return
      event.preventDefault()
      const history = promptHistory()
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(null)
        setText(historyStash.current)
      } else {
        setHistoryIndex(next)
        setText(history[next]!)
      }
    }
  }

  // ─── Derived view state ────────────────────────────────────────────────────
  const queued: QueuedItem[] = [
    ...(queue?.steering ?? []).map((t, index) => ({ kind: 'steering' as const, text: t, index })),
    ...(queue?.followUp ?? []).map((t, index) => ({ kind: 'followUp' as const, text: t, index }))
  ].map((item, _i, all) => {
    const twin = all
      .filter((other) => other.kind === item.kind && other.text === item.text)
      .indexOf(item)
    return { ...item, images: queuedImageCount(agentId, item.kind, item.text, twin) }
  })
  const hasContent = text.trim().length > 0 || draft.images.length > 0
  const hasAttachments = draft.images.length + draft.pending.length > 0
  const canRunBash = supportsEngineCommand(engine, 'bash')
  const bashMode = canRunBash
    ? text.startsWith('!!')
      ? 'exclude'
      : text.startsWith('!')
        ? 'include'
        : null
    : null
  const imagesUnsupported =
    draft.images.length > 0 && model
      ? model.input.length === 0
        ? `Image support could not be verified for ${model.name}.`
        : !model.input.includes('image')
          ? `${model.name} can’t read images. They will be ignored.`
          : undefined
      : undefined
  const placeholderHints = useMemo(
    () =>
      !ready
        ? [`${ENGINE_LABELS[engine]} is starting…`]
        : compacting
          ? ['Compacting context… You can keep drafting or stop compaction.']
          : running
            ? [`Steer the agent, or ${shortcutText('alt+enter')} to queue a follow-up`]
            : IDLE_HINTS.filter((hint) => canRunBash || !hint.startsWith('Run a shell')),
    [ready, compacting, running, engine, canRunBash]
  )

  const menu = menuOpen ? (
    <SuggestionMenu
      key={trigger.kind}
      label={trigger.kind === 'slash' ? 'Commands' : 'Files'}
      items={items}
      active={Math.min(active, Math.max(0, items.length - 1))}
      onActiveChange={setActive}
      onPick={(index) => pick(index, trigger.kind === 'mention' ? 'complete' : 'run')}
      status={
        trigger.kind === 'mention' && mentions.loading ? (
          <Spinner size={11} />
        ) : trigger.kind === 'mention' && trigger.query ? (
          <span className="font-mono font-normal text-fg-3">@{trigger.query}</span>
        ) : null
      }
      empty={
        trigger.kind === 'slash'
          ? `No command matches “/${trigger.query}”`
          : mentions.loading
            ? 'Searching…'
            : `No files match “${trigger.query}”`
      }
      hints={
        trigger.kind === 'slash'
          ? [
              { combo: '↑+↓', label: 'navigate' },
              { combo: 'enter', label: 'run' },
              { combo: 'tab', label: 'add arguments' },
              { combo: 'escape', label: 'close' }
            ]
          : [
              { combo: '↑+↓', label: 'navigate' },
              { combo: 'enter', label: 'insert' },
              { combo: 'escape', label: 'close' }
            ]
      }
    />
  ) : null

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-4 @max-[640px]/pane:px-3 @max-[640px]/pane:pb-3"
    >
      {/*
        Transcript text dissolves under the composer: a near-opaque scrim plus a blur that fades in from the top.
        macOS can draw the blur without its mask, which cuts a hard edge through the text: there the blur starts
        where the scrim is already opaque.
      */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-x-0 bottom-0 backdrop-blur-[6px] [mask-image:linear-gradient(to_bottom,transparent,black_32px)]',
          platform.os === 'darwin' ? '-top-4' : '-top-14'
        )}
      />
      <div
        aria-hidden
        className="absolute inset-x-0 -top-14 bottom-0 bg-[linear-gradient(to_bottom,transparent,color-mix(in_oklab,var(--surface-1)_96%,transparent)_40px)]"
      />
      <div className="relative w-full max-w-[var(--transcript-w)]">
        <div className="mb-2 flex h-[22px] items-center gap-2 px-1 [&>*]:pointer-events-auto">
          {engine === 'pi' && capabilities?.subagents && <FleetPill agentId={agentId} />}
          {capabilities?.extensionUi && <ExtensionStatusChips agentId={agentId} />}
          <div className="flex-1" />
          <AnimatePresence>
            {escArmed && (
              <motion.span
                key={escArmed}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 2, transition: { duration: 0.12 } }}
                transition={spring.snappy}
                className="inline-flex h-[22px] items-center gap-1.5 rounded-full bg-[var(--glass-strong)] px-2.5 text-xs text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)] backdrop-blur-xl"
              >
                Press <Kbd combo="escape" size="xs" /> again {ESC_LABEL[escArmed]}
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <TodoDock agentId={agentId} />
        {capabilities?.extensionUi && (
          <ExtensionWidgets agentId={agentId} placement="aboveEditor" />
        )}
        <RetryNotice agentId={agentId} />

        <div className="pointer-events-auto relative">
          <AnimatePresence>{menu}</AnimatePresence>
          <div
            data-composer
            data-running={running || undefined}
            className={cn(
              'glass @container/composer relative rounded-lg transition-shadow duration-[var(--dur-slow)] ease-out',
              'shadow-[var(--highlight),0_0_0_1px_var(--hairline-strong),var(--shadow-xl)]',
              'focus-within:shadow-[var(--highlight),0_0_0_1px_color-mix(in_oklab,var(--fg)_16%,transparent),var(--shadow-xl)]',
              running &&
                'shadow-[var(--highlight),0_0_0_1px_color-mix(in_oklab,var(--accent-2)_26%,var(--hairline-strong)),0_0_40px_-18px_var(--accent-2),var(--shadow-xl)] focus-within:shadow-[var(--highlight),0_0_0_1px_color-mix(in_oklab,var(--accent-2)_34%,var(--hairline-strong)),0_0_44px_-16px_var(--accent-2),var(--shadow-xl)]'
            )}
          >
            <div className="pt-1.5">
              {supportsEngineCommand(engine, 'clear_queue') && (
                <QueueChips
                  items={queued}
                  onRemove={(item) => void removeQueued(item)}
                  onRestore={() => void restoreQueue()}
                />
              )}
              {runningBash && (
                <BashRunningRow
                  run={runningBash}
                  onStop={() => void rpc(agentId, { type: 'abort_bash' })}
                />
              )}
              <AttachmentTray
                images={draft.images}
                pending={draft.pending}
                imagesUnsupported={imagesUnsupported}
                onRemove={(id) =>
                  patchDraft((d) => ({ images: d.images.filter((i) => i.id !== id) }))
                }
              />
            </div>

            <div className="relative px-1">
              {text === '' && <RotatingPlaceholder hints={placeholderHints} />}
              {ghostHint && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-1 top-0 overflow-hidden px-2 pt-[7px] text-prose leading-[22px] whitespace-pre"
                >
                  <span className="invisible">{text}</span>
                  <span className="text-fg-3">{ghostHint}</span>
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={text}
                rows={1}
                spellCheck
                aria-label="Message"
                onChange={(e) => {
                  patchDraft({ text: e.target.value })
                  setCaret(e.target.selectionStart)
                  if (historyIndex !== null) setHistoryIndex(null)
                }}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onBlur={() => setDismissedAt(text)}
                onFocus={() => setDismissedAt(null)}
                style={{ height }}
                className={cn(
                  'relative block w-full resize-none bg-transparent px-2 pt-[7px] pb-[7px] text-prose leading-[22px] text-fg focus-visible:outline-none',
                  'transition-[height] duration-[140ms] ease-out motion-reduce:transition-none',
                  height >= MAX_H ? 'overflow-y-auto' : 'overflow-hidden',
                  bashMode && 'font-mono text-[14px]'
                )}
              />
              <textarea
                ref={mirrorRef}
                value={text}
                rows={1}
                readOnly
                tabIndex={-1}
                aria-hidden
                className={cn(
                  'pointer-events-none invisible absolute inset-x-1 top-0 block h-0 resize-none overflow-hidden px-2 pt-[7px] pb-[7px] text-prose leading-[22px]',
                  bashMode && 'font-mono text-[14px]'
                )}
              />
            </div>

            <ComposerFooter
              agentId={agentId}
              ready={ready}
              running={running}
              compacting={compacting}
              hasContent={hasContent}
              hasAttachments={hasAttachments}
              menuOpen={menuOpen}
              text={text}
              bashMode={bashMode}
              onPickAttachments={() => void pickAttachments()}
              onStop={() => void stopAgent(agentId)}
              onSubmit={(mode) => void submit(mode)}
            />

            <AnimatePresence>
              {dragging && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3 rounded-lg bg-[color-mix(in_oklab,var(--surface-2)_92%,transparent)] shadow-[inset_0_0_0_1.5px_var(--accent-border)]"
                >
                  <ImagePlus className="size-5 text-accent-text" />
                  <div className="text-left">
                    <div className="text-ui font-medium text-fg">Drop to attach</div>
                    <div className="text-xs text-fg-3">
                      Images are attached · other files become @mentions
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {capabilities?.extensionUi && (
          <ExtensionWidgets agentId={agentId} placement="belowEditor" />
        )}
      </div>
      <SessionInfoDialog />
    </div>
  )
}
