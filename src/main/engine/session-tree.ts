import type { EngineTreeData, FlatTreeNode, RpcCommand, RpcErrorResponse, RpcResponse, SessionEntry, SessionTreeNode } from '@shared/engine-types'
import type { EngineHandle } from './handle'

/** A `get_tree` response line as the engine sends it. */
export type EngineTreeResponse = RpcErrorResponse | { id?: string; type: 'response'; command: 'get_tree'; success: true; data: EngineTreeData }

/** Pre-order list of a nested session tree, siblings in tree order. Iterative: linear sessions nest once per entry. */
export function flattenSessionTree(roots: SessionTreeNode[]): FlatTreeNode[] {
  const nodes: FlatTreeNode[] = []
  const stack: Array<{ node: SessionTreeNode; parentId: string | null }> = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i]!, parentId: null })
  while (stack.length > 0) {
    const { node, parentId } = stack.pop()!
    const flat: FlatTreeNode = { entry: node.entry, parentId }
    if (node.label !== undefined) flat.label = node.label
    if (node.labelTimestamp !== undefined) flat.labelTimestamp = node.labelTimestamp
    nodes.push(flat)

    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, parentId: node.entry.id })
  }
  return nodes
}

/** The engine's nested `get_tree` answer in the flat form Vengeance passes on (`FlatSessionTree`). */
export function flattenTreeResponse(response: EngineTreeResponse): RpcResponse {
  if (!response.success) return response
  const { tree, leafId } = response.data
  return { ...response, data: { nodes: flattenSessionTree(tree), leafId } }
}

function entryTime(entry: SessionEntry): number {
  return new Date(entry.timestamp).getTime()
}

/**
 * The flat tree the engine's `get_tree` would give for `entries` (its `get_entries` list, file order).
 * Mirrors pi 1.1.0 `dist/core/session-manager.js`: labels as `SessionManager._buildIndex` resolves them
 * (a label entry sets its target's label and labelTimestamp, an empty one clears both; the last one wins),
 * and the tree as `SessionManager.getTree` builds it (a null or self parent makes a root, so does a missing
 * parent; children sorted by timestamp, oldest first, stable; roots in file order).
 */
export function sessionTreeFromEntries(entries: SessionEntry[]): FlatTreeNode[] {
  const labels = new Map<string, { label: string; timestamp: string }>()
  const byId = new Map<string, SessionEntry>()
  for (const entry of entries) {
    byId.set(entry.id, entry)
    if (entry.type !== 'label') continue
    if (entry.label) labels.set(entry.targetId, { label: entry.label, timestamp: entry.timestamp })
    else labels.delete(entry.targetId)
  }

  const roots: SessionEntry[] = []
  const childrenOf = new Map<string, SessionEntry[]>()
  for (const entry of entries) {
    const parentId = entry.parentId
    if (parentId === null || parentId === entry.id || !byId.has(parentId)) {
      roots.push(entry)
      continue
    }
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(entry)
    else childrenOf.set(parentId, [entry])
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => entryTime(a) - entryTime(b))

  const nodes: FlatTreeNode[] = []
  const stack: Array<{ entry: SessionEntry; parentId: string | null }> = []
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ entry: roots[i]!, parentId: null })
  while (stack.length > 0) {
    const { entry, parentId } = stack.pop()!
    const label = labels.get(entry.id)
    nodes.push(label ? { entry, parentId, label: label.label, labelTimestamp: label.timestamp } : { entry, parentId })

    const children = childrenOf.get(entry.id) ?? []
    for (let i = children.length - 1; i >= 0; i--) stack.push({ entry: children[i]!, parentId: entry.id })
  }
  return nodes
}

/**
 * `get_tree` for the renderer. The engine serializes its nested tree recursively and fails past roughly
 * 2200 linear entries (pi 1.1.0: "Maximum call stack size exceeded"), so on any get_tree failure the tree
 * is rebuilt from the flat `get_entries`. When that fails too, the get_tree failure stands.
 */
export async function requestSessionTree(handle: EngineHandle, command: RpcCommand & { type: 'get_tree' }): Promise<RpcResponse> {
  let failure: RpcResponse | Error
  try {
    const response = await handle.send(command)
    if (response.success) return response
    failure = response
  } catch (error) {
    failure = error as Error
  }

  try {
    const entries = await handle.send({ type: 'get_entries' })
    if (entries.success && entries.command === 'get_entries') {
      const { entries: list, leafId } = entries.data
      return { id: command.id, type: 'response', command: 'get_tree', success: true, data: { nodes: sessionTreeFromEntries(list), leafId } }
    }
  } catch {
    // The get_tree failure below is the one to report.
  }
  if (failure instanceof Error) throw failure
  return failure
}
