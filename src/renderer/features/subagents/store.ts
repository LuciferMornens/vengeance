import { useMemo } from 'react'
import { create } from 'zustand'
import type { SubagentRunState, SubagentSnapshotNode } from '@shared/subagents'
import type { SubagentRequestRecord, SubagentRunRecord, SubagentsState } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { runTitle } from './format'

export type SubagentTarget = { runId: string; childId?: string }

export interface SubagentChildView {
  id: string
  label: string
  state: SubagentRunState
  currentTool?: string
  currentToolStartedAt?: number
  turns?: number
  tools?: number
  startedAt?: number
  endedAt?: number
  children: SubagentChildView[]
}

export interface SubagentRunView {
  runId: string
  label: string
  kind: 'subagent' | 'workflow'
  /** 'unknown' = seen in the transcript, no snapshot or notice yet. */
  state: SubagentRunState | 'unknown'
  title?: string
  model?: string
  startedAt?: number
  endedAt?: number
  turns?: number
  tools?: number
  currentTool?: string
  currentToolStartedAt?: number
  needsDecision: boolean
  /** Latest control-notice message while the run is live. */
  attention?: string
  children: SubagentChildView[]
  /** Run this one revived (resume lineage). */
  resumedFrom?: string
  outputPath?: string
  /** The completion notice's summary (shown when the live view has no final output). */
  summary?: string
  /** Short failure reason (`timed out after 30m`). */
  failureReason?: string
  task?: string
  /** Present in the latest async snapshot. */
  live: boolean
}

export interface SubagentFleet {
  active: SubagentRunView[]
  /** The newest finished runs, capped for the fleet popover. */
  recent: SubagentRunView[]
  /** Every run of the session: active first, then finished, newest first (the Agents tab). */
  all: SubagentRunView[]
  needsDecision: number
}

/** Runs still doing (or waiting to do) work. */
export const ACTIVE_STATES: ReadonlySet<SubagentRunView['state']> = new Set(['queued', 'running', 'paused'])
const FAILED_STATES: ReadonlySet<SubagentRunView['state']> = new Set(['failed', 'rejected'])
/** The fleet popover's "Recent" keeps at most this many finished runs. */
const MAX_RECENT = 8

function childView(node: SubagentSnapshotNode): SubagentChildView {
  const running = node.state === 'running'
  return {
    id: node.id,
    label: node.label,
    state: node.state,
    currentTool: running ? node.activity?.currentTool : undefined,
    currentToolStartedAt: running ? node.activity?.currentToolStartedAt : undefined,
    turns: node.activity?.turnCount,
    tools: node.activity?.toolCount,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    children: (node.children ?? []).map(childView)
  }
}

function stateOf(record: SubagentRunRecord, live: boolean): SubagentRunView['state'] {
  const node = record.node
  if (live && node) return node.state
  if (record.final) return record.final.state
  if (node && !ACTIVE_STATES.has(node.state)) return node.state
  return record.foregroundState ?? 'unknown'
}

export function runView(record: SubagentRunRecord, slice: SubagentsState): SubagentRunView {
  const live = slice.snapshot?.runs.some((node) => node.id === record.runId) ?? false
  const state = stateOf(record, live)
  const node = record.node
  const running = state === 'running'
  const startedAt = node?.startedAt ?? record.launchedAt
  const finalEnd = record.final?.durationMs !== undefined && startedAt !== undefined ? startedAt + record.final.durationMs : record.final?.at
  const needsDecision = Object.values(slice.requests).some((entry) => entry.request.runId === record.runId && entry.state !== 'answered')
  return {
    runId: record.runId,
    label: record.label,
    kind: record.kind,
    state,
    title: runTitle(record.title, record.task),
    model: record.model,
    startedAt,
    endedAt: ACTIVE_STATES.has(state) ? undefined : (node?.endedAt ?? finalEnd),
    turns: node?.activity?.turnCount,
    tools: node?.activity?.toolCount,
    currentTool: running ? node?.activity?.currentTool : undefined,
    currentToolStartedAt: running ? node?.activity?.currentToolStartedAt : undefined,
    needsDecision,
    attention: live && ACTIVE_STATES.has(state) ? record.attention : undefined,
    children: (node?.children ?? []).map(childView),
    resumedFrom: record.resumedFrom,
    outputPath: record.final?.outputPath,
    summary: record.final?.summary,
    failureReason: record.final?.reason,
    task: record.task,
    live
  }
}

/** A failure the user has not opened yet; a failed run that was resumed is already handled. */
export function isUnseenFailure(view: SubagentRunView, slice: SubagentsState): boolean {
  if (!FAILED_STATES.has(view.state) || slice.seen[view.runId]) return false
  return !resumedRunIds(slice.runs).has(view.runId)
}

const activeRank = (view: SubagentRunView): number => (view.needsDecision ? 0 : view.state === 'running' ? 1 : 2)

export function fleetOf(slice: SubagentsState): SubagentFleet {
  const views = Object.values(slice.runs).map((record) => runView(record, slice))
  const active = views
    .filter((view) => ACTIVE_STATES.has(view.state) || view.needsDecision)
    .sort((a, b) => activeRank(a) - activeRank(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const finished = views
    .filter((view) => !active.includes(view))
    .sort((a, b) => (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0))
  const needsDecision = Object.values(slice.requests).filter((entry) => entry.state !== 'answered').length
  return { active, recent: finished.slice(0, MAX_RECENT), all: [...active, ...finished], needsDecision }
}

/** Ids of runs a later run revived (the target of some run's `resumedFrom`). */
function resumedRunIds(runs: SubagentsState['runs']): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const record of Object.values(runs)) {
    if (record.resumedFrom) ids.add(record.resumedFrom)
  }
  return ids
}

export function useSubagentsSlice(agentId: string): SubagentsState | undefined {
  return useAgents((s) => s.agents[agentId]?.subagents)
}

const EMPTY_FLEET: SubagentFleet = { active: [], recent: [], all: [], needsDecision: 0 }
const NO_RUN_IDS: ReadonlySet<string> = new Set()

export function useSubagentRun(agentId: string, runId: string | undefined): SubagentRunView | null {
  const slice = useSubagentsSlice(agentId)
  const record = runId ? slice?.runs[runId] : undefined
  return useMemo(() => (record && slice ? runView(record, slice) : null), [record, slice])
}

export function useSubagentFleet(agentId: string): SubagentFleet {
  const slice = useSubagentsSlice(agentId)
  return useMemo(() => (slice ? fleetOf(slice) : EMPTY_FLEET), [slice])
}

/** Ids of the session's runs that were resumed by a later run (stable while the runs do not change). */
export function useResumedRunIds(agentId: string): ReadonlySet<string> {
  const runs = useSubagentsSlice(agentId)?.runs
  return useMemo(() => (runs ? resumedRunIds(runs) : NO_RUN_IDS), [runs])
}

/** The Agents tab's dot: warning while a run waits for a decision, danger for a failure not yet looked at. */
export function useAgentsTabAlert(agentId: string | undefined): 'warning' | 'danger' | null {
  return useAgents((s) => {
    const slice = agentId ? s.agents[agentId]?.subagents : undefined
    if (!slice) return null
    if (Object.values(slice.requests).some((entry) => entry.state !== 'answered')) return 'warning'
    const failed = Object.values(slice.runs).some((record) => isUnseenFailure(runView(record, slice), slice))
    return failed ? 'danger' : null
  })
}

/** The run's oldest supervisor request still waiting for an answer. */
export function usePendingRequest(agentId: string, runId: string): SubagentRequestRecord | undefined {
  return useAgents((s) => {
    const requests = Object.values(s.agents[agentId]?.subagents.requests ?? {})
    return requests.filter((entry) => entry.request.runId === runId && entry.state !== 'answered').sort((a, b) => a.receivedAt - b.receivedAt)[0]
  })
}

export function useSupervisorRequestState(agentId: string, requestId: string): 'pending' | 'sending' | 'answered' {
  return useAgents((s) => s.agents[agentId]?.subagents.requests[requestId]?.state ?? 'pending')
}

// ─── View state: the run open in the Agents tab and the output preview ──────────────────────────

export interface SubagentSelection {
  agentId: string
  runId: string
  childId?: string
  /** Open with the steer box ready. */
  intent?: 'steer'
}

interface SubagentUiStore {
  selection: SubagentSelection | null
  /** Output file shown in the preview dialog. */
  preview: { path: string; cwd: string } | null
  select(selection: SubagentSelection | null): void
  setPreview(preview: { path: string; cwd: string } | null): void
}

export const useSubagentUi = create<SubagentUiStore>()((set) => ({
  selection: null,
  preview: null,
  select: (selection) => set({ selection }),
  setPreview: (preview) => set({ preview })
}))

/** Mark a run's failure as seen (clears the danger dot on the pill and the inspector tab). */
export function markSeen(agentId: string, runId: string): void {
  const agent = useAgents.getState().agents[agentId]
  if (!agent || agent.subagents.seen[runId]) return
  useAgents.getState().patchAgent(agentId, { subagents: { ...agent.subagents, seen: { ...agent.subagents.seen, [runId]: true } } })
}

/** Set a supervisor request's reply state (optimistic while the reply prompt is in flight). */
export function setRequestState(agentId: string, requestId: string, state: 'pending' | 'sending' | 'answered'): void {
  const agent = useAgents.getState().agents[agentId]
  const current = agent?.subagents.requests[requestId]
  if (!agent || !current || current.state === state) return
  useAgents.getState().patchAgent(agentId, { subagents: { ...agent.subagents, requests: { ...agent.subagents.requests, [requestId]: { ...current, state } } } })
}

/** Link a run started by Resume to the run it revived, before the transcript or snapshot mention it. */
export function linkResumedRun(agentId: string, sourceRunId: string, runId: string): void {
  const agent = useAgents.getState().agents[agentId]
  if (!agent || agent.subagents.runs[runId]) return
  const source = agent.subagents.runs[sourceRunId]
  const record: SubagentRunRecord = {
    runId,
    label: source?.label ?? 'agent',
    kind: source?.kind ?? 'subagent',
    task: source?.task,
    model: source?.model,
    resumedFrom: sourceRunId,
    launchedAt: Date.now()
  }
  useAgents.getState().patchAgent(agentId, { subagents: { ...agent.subagents, runs: { ...agent.subagents.runs, [runId]: record } } })
}
