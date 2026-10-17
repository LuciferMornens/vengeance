import { NATIVE_COMPACTION_ENTRY } from '@shared/api/engine'
import type { FlatTreeNode, SessionEntry } from '@shared/engine-types'
import { asControlEvent, asNotifyDetails, asSupervisorRequest, isSubagentMessageType, parseNotifyContent, parseSupervisorReplyPrompt, SUBAGENT_MESSAGE_TYPES, SUBAGENT_WAKE_PREFIX } from '@shared/subagents'
import { parseProviderError } from '../chat/provider-error'
import { userText } from '../chat/transcript-items'

export type BranchNodeKind = 'start' | 'user' | 'assistant' | 'compaction' | 'branch_summary' | 'custom' | 'subagent' | 'bash' | 'tool' | 'meta'

/**
 * A node of the readable session tree. Raw entries are folded: tool results, model/thinking changes,
 * labels and other bookkeeping entries attach to the nearest visible node, and an assistant turn
 * (assistant → tool results → assistant …) collapses into one node until the tree branches.
 * The `all` filter keeps every raw entry as its own node instead.
 */
export interface BranchNode {
  id: string
  kind: BranchNodeKind
  /** Every raw entry folded into this node. */
  entryIds: string[]
  /** Last folded entry: "go to this point" / "continue from here" keep everything up to it. */
  tipId: string
  /** Parent of the first entry (fork point for user messages). */
  parentId: string | null
  text: string
  timestamp: number
  toolNames: string[]
  label?: string
  /** Entry that carries `label` (labels can sit on any folded entry); the node's own id otherwise. */
  labelEntryId: string
  children: BranchNode[]
  /** On the path root → current leaf. */
  onPath: boolean
  /** Contains the current leaf. */
  isLeaf: boolean
  /** Subagent runs a subagent notice reports (their child sessions can be opened). */
  subagentRunIds?: string[]
}

/** pi's `treeFilterMode` values (settings.md), the initial filter of the tree view. */
export type TreeFilterMode = 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all'

export const TREE_FILTER_MODES: TreeFilterMode[] = ['default', 'no-tools', 'user-only', 'labeled-only', 'all']

export function isTreeFilterMode(value: unknown): value is TreeFilterMode {
  return typeof value === 'string' && (TREE_FILTER_MODES as string[]).includes(value)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c: { type?: string; text?: string }) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join(' ')
}

/** Markdown → one plain line for previews. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // "## Goal" + next line reads "Goal: …" once lines are joined (headings without their own punctuation).
    .replace(/^\s{0,3}#{1,6}\s+(.*?[^.:!?])\s*$/gm, '$1:')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|~~|\*/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const MODEL_WORDS: Record<string, string> = { gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', llama: 'Llama', grok: 'Grok', mistral: 'Mistral', deepseek: 'DeepSeek', qwen: 'Qwen', kimi: 'Kimi', glm: 'GLM' }

/**
 * Readable name for a model id from a session file ("claude-sonnet-4-5" → "Claude Sonnet 4.5", "gpt-5-mini" →
 * "GPT-5 Mini"): the tree only has ids, not the catalog's names. Date suffixes are dropped.
 */
export function modelDisplayName(id: string): string {
  const parts = id.replace(/^.*\//, '').replace(/[-_]\d{8}$/, '').split(/[-_]/).filter(Boolean)
  const words: string[] = []
  for (const part of parts) {
    const previous = words.at(-1)
    if (previous && /^\d+$/.test(part) && /\d$/.test(previous)) words[words.length - 1] = `${previous}.${part}`
    else if (previous === 'GPT') words[words.length - 1] = `GPT-${part}`
    else words.push(MODEL_WORDS[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1))
  }
  return words.join(' ')
}

type Classified = { kind: BranchNodeKind; text: string; tools: string[]; runIds?: string[] } | null

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const ABSOLUTE_PATH = /[A-Za-z]:[\\/][^\s)"'`]*|(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]*/g
const MODEL_HINT = /subagent(?:_supervisor)?\(\{.*?\}\)/g

/** A subagent notice as one human line (same wording as the transcript): no run ids, paths or model instructions. */
function subagentNoticeText(customType: string, text: string, details: unknown): string {
  let line = text
  if (customType === SUBAGENT_MESSAGE_TYPES.notify) {
    const notice = parseNotifyContent(text)
    const who = notice.agent ?? 'Subagent'
    line = notice.failed ? `${who} failed${notice.reason ? ` · ${notice.reason}` : ''}` : `${who} finished${notice.summary ? ` · ${notice.summary}` : ''}`
  } else if (customType === SUBAGENT_MESSAGE_TYPES.supervisorRequest) {
    const request = asSupervisorRequest(details)
    if (request) line = `${request.agent} asked · ${request.requestBody}`
  } else if (customType === SUBAGENT_MESSAGE_TYPES.controlNotice) {
    const event = asControlEvent(details)
    if (event) line = event.message
  }
  return line.replace(MODEL_HINT, '').replace(UUID, '').replace(ABSOLUTE_PATH, ' ').replace(/\bPi\b/g, 'Engine')
}

/** Run ids of a subagent notice: pi-subagents' `details.runs`, or a single `details.runId`. */
function noticeRunIds(details: unknown): string[] {
  const runs = asNotifyDetails(details)?.runs.map((run) => run.runId)
  if (runs) return runs
  const runId = (details as { runId?: unknown } | null)?.runId
  return typeof runId === 'string' ? [runId] : []
}

/** A shown extension message: subagent notices read as subagent events, anything else as its own text. */
function customNode(customType: string, content: unknown, details: unknown): Classified {
  const text = textOf(content)
  if (isSubagentMessageType(customType)) return { kind: 'subagent', text: subagentNoticeText(customType, text, details), tools: [], runIds: noticeRunIds(details) }
  return { kind: 'custom', text, tools: [] }
}

/** A user message, or a prompt the subagents extension wrote for the user: wake-ups fold away, relayed replies read as answers. */
function userNode(text: string): Classified {
  if (text.startsWith(SUBAGENT_WAKE_PREFIX)) return null
  const reply = parseSupervisorReplyPrompt(text)
  if (reply) return { kind: 'user', text: `Answered ${reply.agent} · ${reply.message}`, tools: [] }
  return { kind: 'user', text, tools: [] }
}

/** Readable node for a conversation entry; null for bookkeeping entries (folded into a neighbour). */
function classify(entry: SessionEntry): Classified {
  switch (entry.type) {
    case 'message': {
      const m = entry.message
      if (m.role === 'user') return userNode(userText(m))
      if (m.role === 'assistant') {
        const text = m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' ')
        const tools = m.content.flatMap((c) => (c.type === 'toolCall' ? [c.name] : []))
        // A failed reply without text reads as the chat's error headline, not the provider's raw payload.
        return {
          kind: 'assistant',
          text: text || (m.errorMessage ? parseProviderError(m.errorMessage).title : ''),
          tools
        }
      }
      if (m.role === 'bashExecution') return { kind: 'bash', text: m.command, tools: [] }
      if (m.role === 'custom') return m.display ? customNode(m.customType, m.content, m.details) : null
      if (m.role === 'compactionSummary') return { kind: 'compaction', text: m.summary, tools: [] }
      if (m.role === 'branchSummary') return { kind: 'branch_summary', text: m.summary, tools: [] }
      return null
    }
    case 'compaction':
      return { kind: 'compaction', text: entry.summary, tools: [] }
    case 'branch_summary':
      return { kind: 'branch_summary', text: entry.summary, tools: [] }
    case 'custom_message':
      return entry.display ? customNode(entry.customType, entry.content, entry.details) : null
    default:
      return null
  }
}

/** Every entry as a node (the `all` filter): tool results and bookkeeping get their own rows. */
function classifyRaw(entry: SessionEntry): Classified {
  const readable = classify(entry)
  if (readable) return readable
  switch (entry.type) {
    case 'message': {
      const m = entry.message
      if (m.role === 'toolResult') return { kind: 'tool', text: `${m.toolName}${m.isError ? ' · failed' : ''}`, tools: [] }
      if (m.role === 'user') return { kind: 'meta', text: 'Woke up for subagent updates', tools: [] }
      if (m.role === 'system') return { kind: 'meta', text: 'System prompt', tools: [] }
      if (m.role === 'custom') return { kind: 'meta', text: `Hidden message · ${m.customType}`, tools: [] }
      return { kind: 'meta', text: m.role, tools: [] }
    }
    case 'model_change':
      return { kind: 'meta', text: `Model · ${modelDisplayName(entry.modelId)}`, tools: [] }
    case 'thinking_level_change':
      return { kind: 'meta', text: `Thinking · ${entry.thinkingLevel}`, tools: [] }
    case 'label':
      return { kind: 'meta', text: entry.label ? `Label · ${entry.label}` : 'Label cleared', tools: [] }
    case 'session_info':
      return { kind: 'meta', text: entry.name ? `Renamed · ${entry.name}` : 'Name cleared', tools: [] }
    case 'custom':
      if (entry.customType === NATIVE_COMPACTION_ENTRY) return { kind: 'meta', text: 'OpenAI native compaction', tools: [] }
      return { kind: 'meta', text: `Extension data · ${entry.customType}`, tools: [] }
    case 'custom_message':
      return { kind: 'meta', text: `Hidden message · ${entry.customType}`, tools: [] }
    case 'context_edit':
      return { kind: 'meta', text: entry.replacement ? 'Context edit' : 'Removed from context', tools: [] }
    case 'usage':
      return null
    default:
      return null
  }
}

function entryTime(entry: SessionEntry): number {
  if (entry.type === 'message' && typeof entry.message.timestamp === 'number') return entry.message.timestamp
  const t = new Date(entry.timestamp).getTime()
  return Number.isNaN(t) ? 0 : t
}

export interface BranchTree {
  /** Synthetic "session start" node; the first entries hang off it (several when the very first message was re-edited). */
  root: BranchNode
  /** Number of nodes off the active path (abandoned work). */
  abandoned: number
  /** Branch points (nodes with more than one child). */
  forks: number
  /** Nodes that carry a label. */
  labeled: number
}

const NO_CHILDREN: FlatTreeNode[] = []

/**
 * Fold the engine's entry tree (`get_tree` / `sessions:tree` nodes, pre-order) into readable nodes.
 * Iterative: sessions can be thousands of entries deep.
 */
export function buildBranchTree(nodes: FlatTreeNode[], leafId: string | null, raw = false): BranchTree {
  const parentOf = new Map<string, string | null>()
  const labels = new Map<string, string>()
  const roots: FlatTreeNode[] = []
  const childrenOf = new Map<string, FlatTreeNode[]>()
  for (const node of nodes) {
    // Pre-order lists a parent before its children; a node whose parent is missing becomes a root.
    const parentId = node.parentId !== null && parentOf.has(node.parentId) ? node.parentId : null
    if (parentId === null) {
      roots.push(node)
    } else {
      const siblings = childrenOf.get(parentId)
      if (siblings) siblings.push(node)
      else childrenOf.set(parentId, [node])
    }
    parentOf.set(node.entry.id, node.entry.parentId)
    if (node.label) labels.set(node.entry.id, node.label)
  }
  const onPath = new Set<string>()
  for (let id: string | null | undefined = leafId; id; id = parentOf.get(id)) onPath.add(id)

  const first = roots[0]?.entry
  const root: BranchNode = {
    id: '__start',
    kind: 'start',
    entryIds: [],
    tipId: first?.id ?? '',
    parentId: null,
    text: '',
    timestamp: first ? entryTime(first) : 0,
    toolNames: [],
    labelEntryId: '',
    children: [],
    onPath: true,
    isLeaf: false
  }
  const stack: Array<{ node: FlatTreeNode; attach: BranchNode; merge: BranchNode | null }> = roots.map((node) => ({ node, attach: root, merge: null })).reverse()
  while (stack.length) {
    const { node, attach, merge } = stack.pop()!
    const entry = node.entry
    const info = raw ? classifyRaw(entry) : classify(entry)
    let current: BranchNode | null = null
    if (info && info.kind === 'assistant' && merge) {
      merge.entryIds.push(entry.id)
      merge.tipId = entry.id
      merge.toolNames.push(...info.tools)
      if (info.text) merge.text = plainPreview(info.text)
      current = merge
    } else if (info) {
      current = {
        id: entry.id,
        kind: info.kind,
        entryIds: [entry.id],
        tipId: entry.id,
        parentId: entry.parentId,
        text: info.kind === 'user' || info.kind === 'bash' ? info.text.trim() : plainPreview(info.text),
        timestamp: entryTime(entry),
        toolNames: [...info.tools],
        labelEntryId: entry.id,
        children: [],
        onPath: false,
        isLeaf: false,
        subagentRunIds: info.runIds?.length ? info.runIds : undefined
      }
      attach.children.push(current)
    } else {
      // Bookkeeping entry: fold into the nearest visible node so path/leaf markers stay accurate.
      const host = merge ?? attach
      host.entryIds.push(entry.id)
      if (entry.type === 'message' && entry.message.role === 'toolResult') host.tipId = entry.id
      if (entry.type === 'model_change' && host.kind === 'start') host.text = modelDisplayName(entry.modelId)
    }
    const host = current ?? merge ?? attach
    const label = labels.get(entry.id)
    if (label && host.kind !== 'start') {
      host.label = label
      host.labelEntryId = entry.id
    }
    const nextAttach = current ?? attach
    const children = childrenOf.get(node.entry.id) ?? NO_CHILDREN
    // Folding only continues along a single-child chain; a branch point starts new nodes.
    const nextMerge = !raw && children.length === 1 ? (current?.kind === 'assistant' ? current : current ? null : merge) : null
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, attach: nextAttach, merge: nextMerge })
  }

  let abandoned = 0
  let forks = 0
  let labeled = 0
  const mark: BranchNode[] = [...root.children]
  root.isLeaf = !!leafId && root.entryIds.includes(leafId)
  if (root.children.length > 1) forks++
  while (mark.length) {
    const n = mark.pop()!
    n.onPath = n.entryIds.some((id) => onPath.has(id))
    n.isLeaf = !!leafId && n.entryIds.includes(leafId)
    if (!n.onPath) abandoned++
    if (n.children.length > 1) forks++
    if (n.label) labeled++
    mark.push(...n.children)
  }
  return { root, abandoned, forks, labeled }
}

/** Whether a node shows under a filter (the start node and the current position always do). */
function visible(node: BranchNode, mode: TreeFilterMode): boolean {
  if (node.kind === 'start' || node.isLeaf) return true
  switch (mode) {
    case 'user-only':
      return node.kind === 'user'
    case 'labeled-only':
      return node.label !== undefined
    case 'no-tools':
      return !(node.kind === 'assistant' && !node.text && node.toolNames.length > 0)
    default:
      return true
  }
}

/**
 * The tree under a filter: hidden nodes are spliced out and their children hang off the nearest shown
 * ancestor (like the TUI's flattened list). `all` is built unfolded by `buildBranchTree(…, true)`.
 */
export function filterBranchTree(root: BranchNode, mode: TreeFilterMode): BranchNode {
  if (mode === 'default' || mode === 'all') return root
  const out = new Map<BranchNode, BranchNode[]>()
  const stack: Array<{ node: BranchNode; done: boolean }> = [{ node: root, done: false }]
  while (stack.length) {
    const item = stack.pop()!
    if (!item.done) {
      stack.push({ node: item.node, done: true })
      for (const child of item.node.children) stack.push({ node: child, done: false })
      continue
    }
    const children = item.node.children.flatMap((child) => out.get(child) ?? [])
    for (const child of item.node.children) out.delete(child)
    out.set(item.node, visible(item.node, mode) ? [{ ...item.node, children }] : children)
  }
  return out.get(root)![0]!
}

/** The child that continues the current line: the active one, else the most recent. */
export function primaryChild(node: BranchNode): BranchNode | undefined {
  return node.children.find((c) => c.onPath) ?? node.children[node.children.length - 1]
}

/** Entry to move the leaf to for "go to this point": a user message itself (pi rewinds to its parent), else the turn's last entry. */
export function navigationTarget(node: BranchNode): string {
  return node.kind === 'user' ? node.id : node.tipId
}
