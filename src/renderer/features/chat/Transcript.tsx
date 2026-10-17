import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent
} from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { ArrowDown } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import { spring } from '../../lib/motion'
import { bashRunLanded, hydrateMessages } from '../../store/agent-reducer'
import type { AgentState, BashRun, TranscriptEntry } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { Shimmer, toast } from '../../ui'
import { Markdown, MermaidModeProvider, type MermaidMode } from '../../ui/Markdown'
// The effective-settings module directly: the settings feature index is a lazily loaded chunk.
import { useEffectiveSetting } from '../settings/effective'
import { DisclosureAgentContext } from '../tools/disclosure'
import { ActivityGroup } from './ActivityGroup'
import { earlierMessages, EarlierHistoryContext, type EarlierHistory } from './earlier-history'
import { SessionEmptyState } from './EmptyState'
import { TurnActions } from './MessageActions'
import {
  AbortedNote,
  AssistantErrorCard,
  BashMessageCard,
  BashRunCard,
  BranchSummaryNote,
  CompactingNote,
  CompactionNote,
  CustomMessageCard,
  RetriedNote,
  RetryFailedCard,
  retriesGaveUpOn,
  retryPending,
  UnknownNote
} from './notices'
import { SubagentUpdates, SupervisorReplyRow, WakeDivider } from './subagent-notices'
import { ThinkingBlock } from './ThinkingBlock'
import {
  buildStreamingItems,
  earlierSegments,
  joinItems,
  segmentItems,
  settledTranscript,
  type Segment,
  type TranscriptItem,
  type TurnInfo
} from './transcript-items'
import { UserMessageView } from './UserMessage'

/** Settled segments above this count are virtualized (≈40 turns); shorter sessions render as plain DOM. */
const VIRTUALIZE_AFTER = 80
/** Top padding of the transcript column (pt-8): where the virtual list starts inside the scroller. */
const LIST_TOP = 32

const ItemView = memo(function ItemView({
  agentId,
  item,
  readOnly
}: {
  agentId: string
  item: TranscriptItem
  readOnly: boolean
}) {
  switch (item.kind) {
    case 'user':
      return <UserMessageView agentId={agentId} message={item.message} readOnly={readOnly} />
    case 'thinking':
      return (
        <ThinkingBlock agentId={agentId} itemKey={item.key} blocks={item.blocks} live={item.live} />
      )
    case 'text':
      return <Markdown text={item.text} live={item.live} />
    case 'tools':
      return <ActivityGroup agentId={agentId} calls={item.calls} />
    case 'error':
      return <AssistantErrorCard agentId={agentId} message={item.message} />
    case 'retried':
      return <RetriedNote message={item.message} compacted={item.compacted} />
    case 'aborted':
      return <AbortedNote />
    case 'bash':
      return <BashMessageCard agentId={agentId} message={item.message} />
    case 'compaction':
      return <CompactionNote message={item.message} leading={item.leading} />
    case 'branch':
      return <BranchSummaryNote message={item.message} />
    case 'custom':
      return <CustomMessageCard message={item.message} />
    case 'subagent-notices':
      return <SubagentUpdates agentId={agentId} notices={item.notices} groupKey={item.key} />
    case 'wake':
      return <WakeDivider />
    case 'supervisor-reply':
      return <SupervisorReplyRow agentId={agentId} message={item.message} rowKey={item.key} />
    case 'unknown':
      return <UnknownNote role={item.role} />
    case 'turn':
      return <TurnActions agentId={agentId} turn={item.turn} latest={false} />
  }
})

/**
 * One segment plus the gap below it (pb-7, so virtualized measurement includes spacing). Turn actions float
 * in that gap. Settled turns outside a virtual list skip off-screen layout/paint via content-visibility; the
 * paint containment would clip the actions' -ml-1.5, hence the -mx/px widening.
 */
const SegmentView = memo(function SegmentView({
  agentId,
  segment: seg,
  contained,
  tail
}: {
  agentId: string
  segment: Segment
  contained: boolean
  tail: TurnInfo | null
}) {
  return (
    <div
      className={cn(
        'pb-7',
        seg.muted && 'opacity-60',
        seg.kind === 'turn' && 'group/turn',
        contained &&
          seg.kind === 'turn' &&
          '-mx-3 px-3 [contain-intrinsic-size:auto_160px] [content-visibility:auto]'
      )}
    >
      <section
        data-segment={seg.kind}
        className={cn('relative flex flex-col', seg.kind === 'turn' ? 'gap-3.5' : 'gap-2')}
      >
        {seg.items.map((item) => (
          <ItemView key={item.key} agentId={agentId} item={item} readOnly={!!seg.muted} />
        ))}
        {tail && <TurnActions agentId={agentId} turn={tail} latest />}
      </section>
    </div>
  )
})

/** Long sessions: only the settled segments near the viewport are mounted (sizes are measured and kept by key). */
const VirtualSegments = memo(function VirtualSegments({
  agentId,
  segments,
  scrollRef
}: {
  agentId: string
  segments: Segment[]
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const getScrollElement = useCallback(() => scrollRef.current, [scrollRef])
  const getItemKey = useCallback((index: number) => segments[index]!.key, [segments])
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement,
    estimateSize: () => 180,
    getItemKey,
    overscan: 6,
    scrollMargin: LIST_TOP,
    useFlushSync: false
  })
  return (
    <div
      data-virtual-segments
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${row.start - LIST_TOP}px)` }}
        >
          <SegmentView
            agentId={agentId}
            segment={segments[row.index]!}
            contained={false}
            tail={null}
          />
        </div>
      ))}
    </div>
  )
})

/** `!command` runs that are not (yet) part of the session messages. */
function pendingBashRuns(bash: Record<string, BashRun>, entries: TranscriptEntry[]): BashRun[] {
  const runs = Object.values(bash)
  if (runs.length === 0) return []
  return runs.filter((run) => !bashRunLanded(run, entries))
}

function WorkingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex h-7 items-center gap-2.5 text-sm"
    >
      <span className="relative flex size-4 items-center justify-center">
        <span className="absolute inset-0 animate-[v-pulse_1.4s_ease-in-out_infinite] rounded-full bg-accent-soft" />
        <span className="size-1.5 rounded-full bg-accent" />
      </span>
      <Shimmer className="font-medium">Working…</Shimmer>
    </motion.div>
  )
}

function isWaiting(agent: AgentState): boolean {
  if (agent.phase !== 'running' || retryPending(agent) || agent.compaction) return false
  if (agent.streaming) return agent.streaming.message.role !== 'assistant'
  return !Object.values(agent.tools).some((t) => t.status === 'running' || t.status === 'pending')
}

/** After a wheel, scroll key or touch, this long counts as the user scrolling (smooth and fling scrolls run on). */
const SCROLL_INTENT_MS = 700
const SCROLL_UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home'])
const MIDDLE_BUTTON = 1
/** Within this distance (px) of the bottom the view follows it again. */
const PINNED_PX = 12
/** Unpinned beyond this distance (px), the "Jump to latest" pill shows. */
const DETACHED_PX = 80

function isScrollUpKey(event: KeyboardEvent): boolean {
  return SCROLL_UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  )
}

/**
 * Stick to the bottom while content grows, release when the user scrolls up. Only the user's own scrolling
 * releases (wheel, scroll keys, scrollbar or selection drag, touch, or an upward scroll while nothing changed
 * size: middle-click autoscroll, a screen reader): content growing below the view (rows measuring taller,
 * images loading) keeps following. "Jump to latest" glides there
 * and lands on the bottom as it ends, wherever virtualized rows that measured on the way moved it.
 */
function useStickToBottom(agentId: string) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const pinned = useRef(true)
  const jumping = useRef(false)
  const lastScrollTop = useRef(0)
  const lastScrollHeight = useRef(0)
  const intentUntil = useRef(0)
  const intentEnd = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A mouse button is down on the transcript (scrollbar drag, drag selection). */
  const pointerHeld = useRef(false)
  /** A finger is on the transcript (touch pan), and whether it scrolled the view (a tap does not). */
  const touchHeld = useRef(false)
  const touchScrolled = useRef(false)
  /** The input that came last: focus following a click or tap is not the user moving the view. */
  const lastInput = useRef<'pointer' | 'key'>('key')
  const [detached, setDetached] = useState(false)

  /** The user is moving the view: following the bottom now would fight them. */
  const userScrolling = useCallback(
    () => pointerHeld.current || touchHeld.current || performance.now() < intentUntil.current,
    []
  )

  /**
   * The app moved the view: a scroll event that merges this write with another scroll (a screen reader's in the
   * same frame) is compared with where the write left it, not with the frame before the growth it followed.
   */
  const noteWrite = useCallback((el: HTMLElement) => {
    lastScrollTop.current = el.scrollTop
    lastScrollHeight.current = el.scrollHeight
  }, [])

  // A "Jump to latest" glide is left to finish: restarting it on every growth crawls behind a fast stream.
  // Its scroll end lands on the bottom (onScrollEnd).
  const follow = useCallback(() => {
    const el = scrollRef.current
    if (!el || jumping.current) return
    // Unpinned a little above the bottom, the answer growing below carries the view past the pill's distance.
    if (!pinned.current) {
      if (el.scrollHeight - el.scrollTop - el.clientHeight > DETACHED_PX) setDetached(true)
      return
    }
    if (userScrolling()) return
    el.scrollTop = el.scrollHeight
    noteWrite(el)
  }, [userScrolling, noteWrite])

  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      const el = scrollRef.current
      if (!el) return
      pinned.current = true
      // The jump is the user's latest word: an earlier wheel's intent window must not read the glide as leaving.
      intentUntil.current = 0
      // Already on the bottom a smooth scroll moves nothing and never ends, which would leave following off.
      jumping.current = smooth && el.scrollHeight - el.scrollTop - el.clientHeight >= 1
      setDetached(false)
      // Long jumps start two screens above the bottom: a glide across thousands of pixels is slow and fights
      // the virtualized rows that mount and measure on the way.
      if (smooth && el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 2)
        el.scrollTop = el.scrollHeight - el.clientHeight * 3
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
      noteWrite(el)
    },
    [noteWrite]
  )

  /** A jump always lands exactly on the bottom, even when rows above changed size mid-flight. */
  const onScrollEnd = useCallback(() => {
    const el = scrollRef.current
    if (!el || !jumping.current) return
    jumping.current = false
    if (!pinned.current) return
    el.scrollTop = el.scrollHeight
    noteWrite(el)
  }, [noteWrite])

  // The content node mounts/unmounts with the empty state, so observe it through a callback ref. Its border box
  // counts the bottom padding, which follows the composer dock (`--composer-h`): a taller dock keeps a pinned
  // view on the bottom too.
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      if (!node) return
      observer.current = new ResizeObserver(follow)
      observer.current.observe(node, { box: 'border-box' })
      follow()
    },
    [follow]
  )

  useLayoutEffect(() => {
    pinned.current = true
    jumping.current = false
    setDetached(false)
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    noteWrite(el)
  }, [agentId, noteWrite])

  useEffect(
    () => () => {
      observer.current?.disconnect()
      if (intentEnd.current !== null) clearTimeout(intentEnd.current)
    },
    []
  )

  // Growth skipped while the user was scrolling is followed once they stop, if they stayed pinned.
  const markIntent = useCallback(() => {
    intentUntil.current = performance.now() + SCROLL_INTENT_MS
    if (intentEnd.current !== null) clearTimeout(intentEnd.current)
    intentEnd.current = setTimeout(follow, SCROLL_INTENT_MS)
  }, [follow])

  // Scroll keys reach the transcript from inside it or from the page body (after a click on its text).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      lastInput.current = 'key'
      const target = event.target
      if (!isScrollUpKey(event) || isEditable(target)) return
      const inTranscript = target instanceof Node && !!scrollRef.current?.contains(target)
      if (inTranscript || target === document.body) markIntent()
    }
    const onAnyPointerDown = () => {
      lastInput.current = 'pointer'
    }
    // A release outside the window still ends a drag; growth skipped during it is followed now.
    const onPointerRelease = () => {
      if (!pointerHeld.current) return
      pointerHeld.current = false
      follow()
    }
    // A fling after a touch pan keeps scrolling a moment.
    const onTouchRelease = () => {
      if (!touchHeld.current) return
      touchHeld.current = false
      if (touchScrolled.current) markIntent()
      else follow()
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onAnyPointerDown, true)
    window.addEventListener('pointerup', onPointerRelease)
    window.addEventListener('pointercancel', onPointerRelease)
    window.addEventListener('touchend', onTouchRelease)
    window.addEventListener('touchcancel', onTouchRelease)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onAnyPointerDown, true)
      window.removeEventListener('pointerup', onPointerRelease)
      window.removeEventListener('pointercancel', onPointerRelease)
      window.removeEventListener('touchend', onTouchRelease)
      window.removeEventListener('touchcancel', onTouchRelease)
    }
  }, [follow, markIntent])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const movedUp = el.scrollTop < lastScrollTop.current
    // Nothing changed size: an upward move is a scroll (anchoring and a shrink's clamp change the height).
    const unexplainedUp = movedUp && el.scrollHeight === lastScrollHeight.current
    lastScrollTop.current = el.scrollTop
    lastScrollHeight.current = el.scrollHeight
    if (touchHeld.current) touchScrolled.current = true
    if (distance < PINNED_PX) {
      pinned.current = true
      jumping.current = false
      setDetached(false)
      return
    }
    // The user scrolled up, or put the view well off the bottom while it was pinned (scrolling down from a
    // spot that was pinned but not on the bottom yet).
    if (
      ((movedUp || distance > DETACHED_PX) && userScrolling()) ||
      (unexplainedUp && !jumping.current && distance > DETACHED_PX)
    ) {
      pinned.current = false
      jumping.current = false
    }
    if (!pinned.current && distance > DETACHED_PX) setDetached(true)
  }, [userScrolling])

  const onWheel = useCallback(
    (event: ReactWheelEvent) => {
      if (event.deltaY < 0) markIntent()
    },
    [markIntent]
  )
  /**
   * Leaves the bottom on purpose (earlier history appears above the view): keep the view where it is (scroll
   * anchoring) instead of following the bottom.
   */
  const hold = useCallback(() => {
    jumping.current = false
    pinned.current = false
  }, [])
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // Autoscroll starts with the press; its upward scrolling then reads as the user's (onScroll).
      if (event.button === MIDDLE_BUTTON) markIntent()
      if (event.pointerType !== 'touch') pointerHeld.current = true
    },
    [markIntent]
  )
  const onTouchStart = useCallback(() => {
    touchHeld.current = true
    touchScrolled.current = false
  }, [])
  /** Focus moving into the transcript from the keyboard (Tab) scrolls it to the focused element. */
  const onFocus = useCallback(() => {
    if (lastInput.current === 'key') markIntent()
  }, [markIntent])

  return {
    scrollRef,
    contentRef,
    detached,
    scrollToBottom,
    onScroll,
    onScrollEnd,
    onWheel,
    onPointerDown,
    onTouchStart,
    onFocus,
    pin: () => (pinned.current = true),
    hold
  }
}

/**
 * Messages before the compaction a transcript starts at (a reopened session's context begins there), loaded from
 * the session file on demand. Loading registers their tool calls with the agent, so the read-only rows show their
 * results; `onShow` runs once they are shown (the view stops following the bottom and stays on the divider).
 */
function useEarlierHistory(
  agentId: string,
  leadingKey: string | undefined,
  onShow: () => void
): EarlierHistory {
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const requestVersion = useRef(0)
  const pending = useRef(false)

  useEffect(() => {
    setEntries(null)
    setLoading(false)
    pending.current = false
    return () => {
      requestVersion.current += 1
    }
  }, [agentId, leadingKey])

  const toggle = useCallback(() => {
    if (pending.current) return
    if (entries) {
      setEntries(null)
      return
    }
    pending.current = true
    const version = ++requestVersion.current
    setLoading(true)
    rpc(agentId, { type: 'get_entries' })
      .then(({ entries: sessionEntries, leafId }) => {
        if (requestVersion.current !== version) return
        const agent = useAgents.getState().agents[agentId]
        if (!agent) return
        const history = hydrateMessages(earlierMessages(sessionEntries, leafId))
        useAgents.getState().patchAgent(agentId, { tools: { ...history.tools, ...agent.tools } })
        onShow()
        setEntries(history.entries)
      })
      .catch((error: Error) => {
        if (requestVersion.current === version)
          toast({
            level: 'error',
            title: 'Could not load earlier messages',
            description: error.message
          })
      })
      .finally(() => {
        if (requestVersion.current !== version) return
        pending.current = false
        setLoading(false)
      })
  }, [agentId, entries, onShow])

  return useMemo(
    () => ({ available: leadingKey !== undefined, entries, loading, toggle }),
    [leadingKey, entries, loading, toggle]
  )
}

/** Settled segments, reusing unchanged segment objects across rebuilds (memoized views skip work). */
function useSettledSegments(entries: TranscriptEntry[]) {
  const previous = useRef<Segment[]>([])
  return useMemo(() => {
    const settled = settledTranscript(entries, previous.current)
    previous.current = settled.segments
    return settled
  }, [entries])
}

const EMPTY_ENTRIES: TranscriptEntry[] = []

/**
 * The conversation for one agent. Settled segments are memoized (virtualized in long sessions); the live
 * tail (the latest prompt, its turn and the streaming message) always stays mounted as plain DOM.
 */
export function Transcript({ agentId }: { agentId: string }) {
  return (
    <DisclosureAgentContext.Provider value={agentId}>
      <AgentTranscript agentId={agentId} />
    </DisclosureAgentContext.Provider>
  )
}

function AgentTranscript({ agentId }: { agentId: string }) {
  const exists = useAgents((s) => !!s.agents[agentId])
  const entries = useAgents((s) => s.agents[agentId]?.entries ?? EMPTY_ENTRIES)
  const streaming = useAgents((s) => s.agents[agentId]?.streaming ?? null)
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  // A given-up turn whose failed response ends the transcript says so on its own card (AssistantErrorCard).
  const retryError = useAgents((s) => {
    const agent = s.agents[agentId]
    if (!agent?.retryError || agent.phase === 'running') return null
    const last = agent.entries[agent.entries.length - 1]?.message
    return last?.role === 'assistant' && retriesGaveUpOn(agent, last) ? null : agent.retryError
  })
  const compaction = useAgents((s) => s.agents[agentId]?.compaction ?? null)
  const bash = useAgents((s) => s.agents[agentId]?.bash)
  const waiting = useAgents((s) => {
    const agent = s.agents[agentId]
    return !!agent && isWaiting(agent)
  })

  const cwd = useAgents((s) => s.agents[agentId]?.info.cwd ?? null)
  const engine = useAgents((s) => s.agents[agentId]?.info.engine ?? 'pi')
  const mermaidSetting = useEffectiveSetting('markdown.mermaid', cwd, engine)
  const mermaid: MermaidMode =
    mermaidSetting === 'off' || mermaidSetting === 'final' ? mermaidSetting : 'streaming'

  const settled = useSettledSegments(entries)
  const streamingItems = useMemo(() => buildStreamingItems(streaming), [streaming])

  // Live tail = from the latest prompt on (or just the open last turn), merged with the streaming message.
  const { head, tail: settledTail } = useMemo(() => {
    const all = settled.segments
    let start = all.length
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.kind === 'user') {
        start = i
        break
      }
      if (all[i]!.kind !== 'turn') break
      start = i
    }
    return { head: all.slice(0, start), tail: all.slice(start) }
  }, [settled.segments])

  const tail = useMemo(() => {
    if (streamingItems.length === 0) return settledTail
    const last = settledTail[settledTail.length - 1]
    const open = last?.kind === 'turn' && last.items[last.items.length - 1]?.kind !== 'turn'
    const merged = open
      ? segmentItems(joinItems(last.items, streamingItems))
      : segmentItems(streamingItems)
    return [...(open ? settledTail.slice(0, -1) : settledTail), ...merged]
  }, [settledTail, streamingItems])

  const {
    scrollRef,
    contentRef,
    detached,
    scrollToBottom,
    onScroll,
    onScrollEnd,
    onWheel,
    onPointerDown,
    onTouchStart,
    onFocus,
    pin,
    hold
  } = useStickToBottom(agentId)

  // Hidden entries (tool results, custom messages) may come first; the first shown item decides.
  const firstItem = settled.segments[0]?.items[0]
  const leadingKey =
    firstItem?.kind === 'compaction' && firstItem.leading ? firstItem.key : undefined
  const earlier = useEarlierHistory(agentId, leadingKey, hold)
  const earlierHead = useMemo(
    () => (earlier.entries ? earlierSegments(earlier.entries) : []),
    [earlier.entries]
  )
  const settledHead = useMemo(
    () => (earlierHead.length > 0 ? [...earlierHead, ...head] : head),
    [earlierHead, head]
  )
  const bashRuns = useMemo(() => (bash ? pendingBashRuns(bash, entries) : []), [bash, entries])

  // A new prompt always brings the view back to the bottom.
  const lastUserKey = tail.find((seg) => seg.kind === 'user')?.key ?? head[head.length - 1]?.key
  const previousUserKey = useRef(lastUserKey)
  useLayoutEffect(() => {
    if (lastUserKey !== previousUserKey.current) {
      previousUserKey.current = lastUserKey
      pin()
    }
  }, [lastUserKey, pin])

  if (!exists) return null
  const empty = entries.length === 0 && !streaming && bashRuns.length === 0
  const lastSegment = tail[tail.length - 1]
  const showTail = !running && !streaming && settled.tail !== null && lastSegment?.kind === 'turn'
  const live = running || !!streaming
  // One list while short, so segments keep their DOM when a new prompt moves them out of the tail.
  const virtual = settledHead.length > VIRTUALIZE_AFTER
  const plain = virtual ? tail : [...settledHead, ...tail]

  return (
    <MotionConfig reducedMotion="user">
      <MermaidModeProvider value={mermaid}>
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            data-transcript-scroll
            onScroll={onScroll}
            onScrollEnd={onScrollEnd}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onTouchStart={onTouchStart}
            onFocus={onFocus}
            className="absolute inset-0 overflow-x-hidden overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_20px)]"
          >
            {empty ? (
              <SessionEmptyState agentId={agentId} />
            ) : (
              <div
                ref={contentRef}
                className="mx-auto flex w-full max-w-[var(--transcript-w)] flex-col px-6 pt-8 pb-[calc(var(--composer-h)+56px)] @max-[640px]/pane:px-4"
              >
                <EarlierHistoryContext.Provider value={earlier}>
                  {virtual && (
                    <VirtualSegments
                      agentId={agentId}
                      segments={settledHead}
                      scrollRef={scrollRef}
                    />
                  )}
                  {plain.map((seg, i) => (
                    <SegmentView
                      key={seg.key}
                      agentId={agentId}
                      segment={seg}
                      contained={!live || i < plain.length - 1}
                      tail={showTail && i === plain.length - 1 ? settled.tail : null}
                    />
                  ))}
                </EarlierHistoryContext.Provider>
                <div className="flex flex-col gap-7 empty:hidden">
                  {bashRuns.map((run) => (
                    <BashRunCard key={run.id} agentId={agentId} run={run} />
                  ))}
                  {retryError && !running && <RetryFailedCard message={retryError} />}
                  {compaction && <CompactingNote compaction={compaction} />}
                  {waiting && <WorkingIndicator />}
                </div>
              </div>
            )}
          </div>
          <AnimatePresence>
            {detached && !empty && (
              <motion.button
                type="button"
                data-jump-latest
                initial={{ opacity: 0, y: 10, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={spring.snappy}
                onClick={() => scrollToBottom(true)}
                className="glass absolute bottom-[calc(var(--composer-h)+14px)] left-1/2 z-10 -ml-[62px] inline-flex h-8 w-[124px] items-center justify-center gap-1.5 rounded-full text-xs font-medium text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline-strong),var(--shadow-lg)] hover:text-fg"
              >
                <ArrowDown className="size-3.5" />
                Jump to latest
                {running && (
                  <span className="ml-0.5 size-1.5 animate-[v-pulse_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
                )}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </MermaidModeProvider>
    </MotionConfig>
  )
}
