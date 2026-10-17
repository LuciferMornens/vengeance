import type { OpenSessionRef } from '@shared/api/app'
import type { AgentInfo, BackgroundAgentInfo } from '@shared/api/engine'
import type { SessionLineage, SessionListItem } from '@shared/api/sessions'
import { sessionIdentityPath } from '@shared/session-identity'

export interface PrimeFamilyNode {
  key: string
  cwd: string
  path?: string
  nativeAgentId?: string
  sessionId?: string
  lineage?: SessionLineage
  open?: AgentInfo
  dormant?: OpenSessionRef
  background?: BackgroundAgentInfo
  saved?: SessionListItem
  parent?: string
  child: boolean
  children: PrimeFamilyNode[]
}

export interface PrimeSessionFamilies {
  nodes: PrimeFamilyNode[]
  byAlias: Map<string, PrimeFamilyNode>
}

interface FamilySources {
  open: AgentInfo[]
  dormant: OpenSessionRef[]
  background: BackgroundAgentInfo[]
  saved: SessionListItem[]
}

export function primeFamilyAlias(kind: 'path' | 'native' | 'session', value: string): string {
  return `prime:${kind}:${kind === 'path' ? sessionIdentityPath(value) : value}`
}

function aliases(node: PrimeFamilyNode): string[] {
  return [
    ...(node.path ? [primeFamilyAlias('path', node.path)] : []),
    ...(node.nativeAgentId ? [primeFamilyAlias('native', node.nativeAgentId)] : [])
  ]
}

function mergeLineage(
  first: SessionLineage | undefined,
  second: SessionLineage | undefined
): SessionLineage | undefined {
  if (!second) return first
  return {
    ...first,
    ...Object.fromEntries(Object.entries(second).filter(([, value]) => value !== undefined))
  }
}

function parentAliases(node: PrimeFamilyNode): string[] {
  const lineage = node.lineage
  const path = lineage?.parentSessionPath ?? node.saved?.parentSessionPath
  return [
    ...(path ? [primeFamilyAlias('path', path)] : []),
    ...(lineage?.parentNativeAgentId
      ? [primeFamilyAlias('native', lineage.parentNativeAgentId)]
      : []),
    ...(lineage?.parentSessionId ? [primeFamilyAlias('session', lineage.parentSessionId)] : [])
  ]
}

function belongsToFamily(node: PrimeFamilyNode, parent?: PrimeFamilyNode): boolean {
  const lineage = node.lineage
  if (
    lineage?.runtimeKind === 'subagent' ||
    lineage?.childId ||
    lineage?.parentNativeAgentId ||
    lineage?.parentSessionId
  ) {
    return true
  }
  // Forks keep their source's depth; their source path is ancestry, not delegation.
  const depth = lineage?.depth
  const parentDepth = parent?.lineage?.depth
  return depth !== undefined && parentDepth !== undefined && depth === parentDepth + 1
}

export function buildPrimeSessionFamilies(sources: FamilySources): PrimeSessionFamilies {
  const byAlias = new Map<string, PrimeFamilyNode>()
  const ambiguousNativeAliases = new Set<string>()
  const nodes = new Set<PrimeFamilyNode>()
  const add = (source: Partial<PrimeFamilyNode> & { cwd: string }): void => {
    const incoming: PrimeFamilyNode = { key: '', child: false, children: [], ...source }
    const identity = aliases(incoming)
    if (!identity.length) return
    const matches = [
      ...new Set(
        identity.flatMap((key) => {
          if (ambiguousNativeAliases.has(key)) return []
          const known = byAlias.get(key)
          if (
            key.startsWith('prime:native:') &&
            known?.path &&
            incoming.path &&
            sessionIdentityPath(known.path) !== sessionIdentityPath(incoming.path)
          ) {
            ambiguousNativeAliases.add(key)
            byAlias.delete(key)
            return []
          }
          return known ?? []
        })
      )
    ]
    const node = matches[0] ?? incoming
    for (const other of matches.slice(1)) {
      Object.assign(node, other, { lineage: mergeLineage(node.lineage, other.lineage) })
      nodes.delete(other)
      for (const [key, value] of byAlias) {
        if (value === other) byAlias.set(key, node)
      }
    }
    Object.assign(
      node,
      Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)),
      { lineage: mergeLineage(node.lineage, source.lineage) }
    )
    const preferredKey = aliases(node)[0] ?? node.key
    node.key =
      !node.path && ambiguousNativeAliases.has(preferredKey)
        ? `${preferredKey}:unresolved:${nodes.size}`
        : preferredKey
    nodes.add(node)
    for (const key of [...identity, ...aliases(node)]) {
      if (!ambiguousNativeAliases.has(key)) byAlias.set(key, node)
    }
    if (node.open) byAlias.set(`prime:app:${node.open.agentId}`, node)
  }

  for (const saved of sources.saved) {
    if (saved.engine === 'prime') {
      add({ cwd: saved.cwd, path: saved.path, sessionId: saved.id, lineage: saved.lineage, saved })
    }
  }
  for (const dormant of sources.dormant) {
    if (dormant.engine === 'prime') {
      add({ cwd: dormant.cwd, path: dormant.path, lineage: dormant.lineage, dormant })
    }
  }
  for (const background of sources.background) {
    if (background.engine === 'prime') {
      add({
        cwd: background.cwd,
        path: background.sessionPath,
        nativeAgentId: background.id,
        sessionId: background.sessionId,
        lineage: background.lineage,
        background
      })
    }
  }
  for (const open of sources.open) {
    if (open.engine === 'prime') {
      add({
        cwd: open.cwd,
        path: open.sessionFile ?? open.args.sessionPath,
        nativeAgentId: open.nativeAgentId ?? open.args.nativeAgentId,
        sessionId: open.sessionId,
        lineage: open.lineage,
        open
      })
    }
  }

  const bySessionId = new Map<string, PrimeFamilyNode[]>()
  for (const node of nodes) {
    if (!node.sessionId) continue
    const key = primeFamilyAlias('session', node.sessionId)
    const candidates = bySessionId.get(key) ?? []
    candidates.push(node)
    bySessionId.set(key, candidates)
  }
  // Imports can copy a header ID into another file; only an unambiguous ID can address a parent.
  for (const [key, candidates] of bySessionId) {
    if (candidates.length === 1) byAlias.set(key, candidates[0]!)
  }
  const byKey = new Map([...nodes].map((node) => [node.key, node]))
  for (const node of nodes) {
    const parentPath = node.lineage?.parentSessionPath ?? node.saved?.parentSessionPath
    const parent = parentAliases(node)
      .map((key) => byAlias.get(key))
      .find(
        (candidate) =>
          candidate &&
          candidate !== node &&
          (!parentPath ||
            !candidate.path ||
            sessionIdentityPath(candidate.path) === sessionIdentityPath(parentPath))
      )
    node.child = belongsToFamily(node, parent)
    if (node.child && parent) node.parent = parent.key
  }
  for (const node of nodes) {
    const visited = new Set([node.key])
    let ancestor = node.parent
    while (ancestor) {
      if (visited.has(ancestor)) {
        node.parent = undefined
        break
      }
      visited.add(ancestor)
      ancestor = byKey.get(ancestor)?.parent
    }
    if (node.parent) byKey.get(node.parent)?.children.push(node)
  }
  return { nodes: [...nodes], byAlias }
}

export function primeFamilyNode(
  families: PrimeSessionFamilies,
  path?: string,
  nativeAgentId?: string,
  agentId?: string
): PrimeFamilyNode | undefined {
  return (
    (path ? families.byAlias.get(primeFamilyAlias('path', path)) : undefined) ??
    (nativeAgentId ? families.byAlias.get(primeFamilyAlias('native', nativeAgentId)) : undefined) ??
    (agentId ? families.byAlias.get(`prime:app:${agentId}`) : undefined)
  )
}

export function primeBackgroundFamilyNode(
  families: PrimeSessionFamilies,
  resident: BackgroundAgentInfo
): PrimeFamilyNode | undefined {
  return (
    primeFamilyNode(families, resident.sessionPath, resident.id) ??
    families.nodes.find((node) => node.background === resident)
  )
}

export function primeFamilyOrphans(
  families: PrimeSessionFamilies,
  inView: (cwd: string) => boolean
): PrimeFamilyNode[] {
  const byKey = new Map(families.nodes.map((node) => [node.key, node]))
  return families.nodes.filter((node) => {
    const parent = node.parent ? byKey.get(node.parent) : undefined
    return node.child && (!parent || !inView(parent.cwd)) && inView(node.cwd)
  })
}
