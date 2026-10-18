import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Bot, Flag, GitBranch, Layers, Puzzle, Settings2, SquareTerminal, Wrench } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatRelativeTime, pluralize } from '../../lib/format'
import { isImeComposing } from '../../lib/keybindings'
import { spring } from '../../lib/motion'
import { Badge, Skeleton, Tooltip } from '../../ui'
import { primaryChild, TREE_FILTER_MODES, type BranchNode, type BranchNodeKind, type TreeFilterMode } from './tree-model'

/**
 * The readable session tree (used by the inspector's Branches tab and the closed-session tree dialog):
 * a rail per line of conversation, side branches hanging off branch points, a node action row on
 * selection, and inline label editing.
 */

const KIND_LABEL: Record<BranchNodeKind, string> = {
  start: 'Session start',
  user: 'You',
  assistant: 'Assistant',
  compaction: 'Compaction',
  branch_summary: 'Branch summary',
  custom: 'Extension',
  subagent: 'Subagent',
  bash: 'Shell',
  tool: 'Tool result',
  meta: 'Session'
}

/** Chip label and tooltip per tree filter (pi's `treeFilterMode`). */
const FILTERS: Record<TreeFilterMode, { label: string; hint: string }> = {
  default: { label: 'Default', hint: 'Conversation without bookkeeping entries' },
  'no-tools': { label: 'No tools', hint: 'Hide tool-only steps' },
  'user-only': { label: 'You', hint: 'Only your messages' },
  'labeled-only': { label: 'Labeled', hint: 'Only labeled steps' },
  all: { label: 'All', hint: 'Every entry, including model and setting changes' }
}

const LEAF_LABEL = 'You are here'

/** Rail line style: solid on the active path, dashed on abandoned branches. */
function rail(onPath: boolean): string {
  return onPath ? 'border-[color-mix(in_oklab,var(--fg)_22%,transparent)]' : 'border-dashed border-[color-mix(in_oklab,var(--fg)_13%,transparent)]'
}

/** How many nodes of the main line to show before "Show earlier". */
const MAIN_LINE_WINDOW = 80
/** How many earlier nodes one "Show earlier" adds: long sessions have thousands, too many rows to mount at once. */
const EARLIER_PAGE = 400

const ICON_KINDS: Partial<Record<BranchNodeKind, typeof Layers>> = {
  start: Flag,
  compaction: Layers,
  branch_summary: GitBranch,
  bash: SquareTerminal,
  custom: Puzzle,
  subagent: Bot,
  tool: Wrench,
  meta: Settings2
}

function NodeMarker({ node }: { node: BranchNode }) {
  const Icon = ICON_KINDS[node.kind]
  if (Icon) {
    return (
      <span
        className={cn(
          'relative z-10 flex size-[18px] items-center justify-center rounded-sm bg-surface-3 shadow-[0_0_0_1px_var(--hairline-strong),0_0_0_3px_var(--bg)] [&_svg]:size-[11px]',
          node.onPath ? 'text-fg-2' : 'text-fg-4',
          node.isLeaf && 'text-accent-text shadow-[0_0_0_1px_var(--accent-border),0_0_0_3px_var(--bg)]'
        )}
      >
        <Icon />
      </span>
    )
  }
  if (node.isLeaf) {
    return (
      <span className="relative z-10 flex size-[18px] items-center justify-center">
        <span className="absolute inset-0 animate-[v-pulse_2.4s_ease-in-out_3] rounded-full bg-accent-soft" />
        <span className="size-[9px] rounded-full bg-accent shadow-[0_0_0_3px_var(--bg)]" />
      </span>
    )
  }
  return (
    <span className="relative z-10 flex size-[18px] items-center justify-center">
      <span
        className={cn(
          node.kind === 'user' ? 'size-[9px] rounded-full' : 'size-[7px] rotate-45 rounded-[2px]',
          node.onPath
            ? node.kind === 'user'
              ? 'bg-fg shadow-[0_0_0_3px_var(--bg)]'
              : 'bg-fg-3 shadow-[0_0_0_3px_var(--bg)]'
            : 'bg-[var(--bg)] shadow-[inset_0_0_0_1.5px_var(--fg-4),0_0_0_3px_var(--bg)]'
        )}
      />
    </span>
  )
}

export interface TreeViewActions {
  /** Actions under the selected node (null hides the row). */
  renderActions(node: BranchNode, controls: { editLabel: () => void }): ReactNode
  /** Save a label (empty clears it); resolve false to keep the editor open. Omit when labels are read-only. */
  saveLabel?: (node: BranchNode, label: string) => Promise<boolean>
}

interface TreeCtx extends TreeViewActions {
  selected: string | null
  select: (id: string | null) => void
  editing: string | null
  setEditing: (id: string | null) => void
  showTools: boolean
  leafLabel: string
  /** Called when a row becomes the current position. */
  revealLeaf: (row: HTMLElement) => void
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

function inView(el: HTMLElement): boolean {
  if (!el.isConnected) return true
  const viewport = scrollParent(el)
  if (!viewport) return true
  const row = el.getBoundingClientRect()
  const view = viewport.getBoundingClientRect()
  return row.bottom > view.top && row.top < view.bottom
}

/**
 * Opens at the current position (deep sessions put it thousands of pixels down), then follows it as messages land,
 * but only while the user is looking at it: scrolling up through history is never interrupted.
 */
function useLeafFollow(): (row: HTMLElement) => void {
  const previous = useRef<HTMLElement | null>(null)
  return (row) => {
    const last = previous.current
    previous.current = row
    if (!last) row.scrollIntoView({ block: 'center' })
    else if (last !== row && inView(last)) row.scrollIntoView({ block: 'nearest' })
  }
}

function LabelField({ node, ctx }: { node: BranchNode; ctx: TreeCtx }) {
  const [value, setValue] = useState(node.label ?? '')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = async () => {
    if (saving || !ctx.saveLabel) return
    if (value.trim() === (node.label ?? '')) return ctx.setEditing(null)
    setSaving(true)
    const ok = await ctx.saveLabel(node, value)
    setSaving(false)
    if (ok) ctx.setEditing(null)
  }
  return (
    <input
      ref={ref}
      value={value}
      maxLength={60}
      disabled={saving}
      aria-label="Label"
      placeholder={node.label ? 'Clear to remove the label' : 'Name this point, e.g. "before refactor"'}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !isImeComposing(e)) void commit()
        else if (e.key === 'Escape') ctx.setEditing(null)
      }}
      className="mt-1 h-6 w-full min-w-0 rounded-sm bg-surface-1 px-2 text-xs text-fg shadow-[inset_0_0_0_1px_var(--hairline-strong)] outline-none placeholder:text-fg-3 focus-visible:shadow-focus focus-visible:outline-none"
    />
  )
}

function NodeRow({ node, first, last, ctx }: { node: BranchNode; first: boolean; last: boolean; ctx: TreeCtx }) {
  const selected = ctx.selected === node.id
  const editing = ctx.editing === node.id
  const dashed = !node.onPath
  const rowRef = useRef<HTMLDivElement>(null)
  const { revealLeaf } = ctx
  // Once per change of the current position, not on every render.
  useEffect(() => {
    if (node.isLeaf && rowRef.current) revealLeaf(rowRef.current)
  }, [node.isLeaf])
  const tools = node.toolNames.length
  const actions = selected ? ctx.renderActions(node, { editLabel: () => ctx.setEditing(node.id) }) : null
  const preview =
    node.kind === 'start'
      ? node.text
        ? `New session · ${node.text}`
        : 'New session'
      : node.text || (tools > 0 ? (ctx.showTools ? node.toolNames.slice(0, 4).join(', ') : 'Worked with tools') : '…')
  return (
    <div ref={rowRef} className="relative" data-tree-node={node.id}>
      {!first && <span className={cn('absolute top-0 left-[17px] h-[15px] border-l', rail(!dashed))} />}
      {!last && <span className={cn('absolute top-[15px] bottom-0 left-[17px] border-l', rail(!dashed))} />}
      <button
        type="button"
        aria-expanded={selected}
        disabled={node.kind === 'start'}
        onClick={() => ctx.select(selected ? null : node.id)}
        className={cn(
          'group relative flex w-full items-start gap-2.5 rounded-md py-1.5 pr-2 pl-2 text-left transition-colors duration-[var(--dur-instant)] focus-visible:outline-none',
          selected ? 'bg-active' : 'enabled:hover:bg-hover focus-visible:bg-hover',
          !node.onPath && !selected && 'opacity-60 hover:opacity-100'
        )}
      >
        <span className="pt-px">
          <NodeMarker node={node} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex h-[18px] items-center gap-1.5 text-xs">
            <span className={cn('font-medium', node.kind === 'user' ? 'text-fg' : 'text-fg-2')}>{KIND_LABEL[node.kind]}</span>
            {tools > 0 && ctx.showTools && <span className="tabular text-fg-3">· {pluralize(tools, 'tool')}</span>}
            {node.isLeaf && <Badge tone="accent">{ctx.leafLabel}</Badge>}
            {node.label && !editing && (
              <Badge className="max-w-[120px]">
                <span className="truncate">{node.label}</span>
              </Badge>
            )}
            <span className="flex-1" />
            <span className="tabular text-2xs text-fg-3">{node.timestamp ? formatRelativeTime(node.timestamp) : ''}</span>
          </span>
          <span className={cn('mt-0.5 line-clamp-2 text-sm leading-snug break-words', node.kind === 'user' ? 'text-fg-2' : 'text-fg-3')}>{preview}</span>
        </span>
      </button>
      {editing && (
        <div className="relative pr-2 pb-1 pl-[38px]">
          {!last && <span className={cn('absolute top-0 bottom-0 left-[17px] border-l', rail(!dashed))} />}
          <LabelField node={node} ctx={ctx} />
        </div>
      )}
      <AnimatePresence initial={false}>
        {actions && !editing && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0, transition: { duration: 0.14 } }} transition={spring.smooth} className="overflow-hidden">
            <div className="relative pt-1.5 pb-2 pl-[38px]">
              {!last && <span className={cn('absolute top-0 bottom-0 left-[17px] border-l', rail(!dashed))} />}
              {actions}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** One line of the conversation: follows the primary child; alternatives hang off as side branches. */
function Chain({ start, ctx, windowed }: { start: BranchNode; ctx: TreeCtx; windowed?: boolean }) {
  const [revealed, setRevealed] = useState(0)
  const nodes: BranchNode[] = []
  for (let n: BranchNode | undefined = start; n; n = primaryChild(n)) nodes.push(n)
  const hidden = windowed ? Math.max(0, nodes.length - MAIN_LINE_WINDOW - revealed) : 0
  const nextPage = Math.min(hidden, EARLIER_PAGE)
  const shown = nodes.slice(hidden)
  return (
    <div>
      {hidden > 0 && (
        <button type="button" onClick={() => setRevealed(revealed + nextPage)} className="mb-1 ml-[30px] h-7 rounded-md px-2 text-xs text-fg-3 hover:bg-hover hover:text-fg-2">
          Show {nextPage} earlier
        </button>
      )}
      {shown.map((node, i) => {
        const primary = primaryChild(node)
        const sides = node.children.filter((c) => c !== primary)
        const last = i === shown.length - 1
        return (
          <Fragment key={node.id}>
            <NodeRow node={node} first={i === 0 && hidden === 0} last={last} ctx={ctx} />
            {sides.length > 0 && (
              <div className="relative">
                {/* The current line keeps running past its alternatives. */}
                {!last && <span className={cn('absolute top-0 bottom-0 left-[17px] border-l', rail(node.onPath))} />}
                {sides.map((side) => (
                  <div key={side.id} className="relative pl-5">
                    <span className={cn('absolute top-[-6px] left-[17px] h-[21px] w-[13px] rounded-bl-[10px] border-b border-l', rail(side.onPath))} />
                    <Chain start={side} ctx={ctx} />
                  </div>
                ))}
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

export interface SessionTreeViewProps extends TreeViewActions {
  root: BranchNode
  /** Show tool names and counts (off under the `no-tools` filter). */
  showTools?: boolean
  /** Window long main lines ("Show N earlier"). */
  windowed?: boolean
  /** Badge on the node holding the leaf. */
  leafLabel?: string
}

export function SessionTreeView({ root, showTools = true, windowed, leafLabel = LEAF_LABEL, renderActions, saveLabel }: SessionTreeViewProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const revealLeaf = useLeafFollow()
  const ctx: TreeCtx = { selected, select: setSelected, editing, setEditing, showTools, leafLabel, revealLeaf, renderActions, saveLabel }
  return <Chain start={root} ctx={ctx} windowed={windowed} />
}

/** pi's tree filters (`treeFilterMode`) as a quiet chip row. */
export function TreeFilterChips({ value, onChange }: { value: TreeFilterMode; onChange: (mode: TreeFilterMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Show in tree" className="flex flex-wrap gap-1">
      {TREE_FILTER_MODES.map((mode) => {
        const active = mode === value
        return (
          <Tooltip key={mode} content={FILTERS[mode].hint}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(mode)}
              className={cn(
                'pressable h-6 rounded-sm px-2 text-xs font-medium transition-colors duration-[var(--dur-instant)]',
                active ? 'bg-surface-3 text-fg shadow-elev-1' : 'text-fg-3 hover:bg-hover hover:text-fg-2'
              )}
            >
              {FILTERS[mode].label}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** Legend under the tree header. */
export function TreeLegend({ abandoned, leafLabel = LEAF_LABEL }: { abandoned: number; leafLabel?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3">
      <span className="flex items-center gap-1.5">
        <span className="size-[7px] rounded-full bg-accent" /> {leafLabel}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-[7px] rounded-full bg-fg" /> Active path
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-[7px] rounded-full shadow-[inset_0_0_0_1.5px_var(--fg-4)]" />
        {abandoned > 0 ? pluralize(abandoned, 'step') + ' on other branches' : 'No other branches'}
      </span>
    </div>
  )
}

export function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-3 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-2.5 w-1/3" />
            <Skeleton className="h-3" />
          </div>
        </div>
      ))}
    </div>
  )
}
