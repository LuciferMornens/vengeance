import { create } from 'zustand'
import type { SpeedMode, SpeedOption, SpeedState } from '@shared/api/speed'
import { bridge } from '../../lib/bridge'
import { on } from '../../lib/ipc'
import type { AgentState } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { toast } from '../../ui'

/**
 * Response speed (Fast / Ultrafast) of each session: reads, changes, notices and `/fast`. The
 * Engine reports changes on a hidden status the reducer parses; Engine 2 is read through the same
 * bridge operation.
 */

export const SPEED_LABELS: Record<SpeedMode, string> = {
  standard: 'Standard',
  fast: 'Fast',
  ultrafast: 'Ultrafast'
}

const SPEED_DESCRIPTIONS: Record<SpeedMode, string> = {
  standard: 'Regular speed and price',
  fast: 'Faster responses',
  ultrafast: 'The fastest responses'
}

const SPEED_READ_DEBOUNCE_MS = 250
/** How long the `/fast` confirmation toast stays. */
const FAST_COMMAND_TOAST_MS = 2200

/** The speed a change is waiting on, by agent id. */
export const usePendingSpeed = create<Record<string, SpeedMode>>(() => ({}))

/** The offered option of `mode`; undefined for standard and modes the model does not offer. */
export function findSpeedOption(speed: SpeedState, mode: SpeedMode): SpeedOption | undefined {
  return speed.options.find((option) => option.mode === mode)
}

/** Show the control when the model has a faster mode, or one this engine or sign-in cannot use. */
export function hasSpeedControl(speed: SpeedState | undefined): speed is SpeedState {
  return !!speed && (speed.options.length > 0 || !!speed.unavailableReason)
}

export function speedDescription(mode: SpeedMode, option?: SpeedOption): string {
  return option?.description || SPEED_DESCRIPTIONS[mode]
}

/** `2× price`, `2.5× price`; undefined when the option has no published price. */
export function formatSpeedPrice(option: SpeedOption | undefined): string | undefined {
  const multiplier = option?.costMultiplier
  return multiplier === undefined ? undefined : `${Number(multiplier.toFixed(2))}\u00d7 price`
}

/** The latest speed read or change of each agent; only its answer is applied. */
const latestSpeedCall = new Map<string, number>()
let speedCallCount = 0

/** A speed read or change of the agent's current session and engine; it supersedes earlier ones. */
interface SpeedCall {
  id: number
  engineGeneration: number
  snapshotRevision: number
}

function startSpeedCall(agent: AgentState): SpeedCall {
  const id = ++speedCallCount
  latestSpeedCall.set(agent.id, id)
  const { engineGeneration, snapshotRevision } = agent
  return { id, engineGeneration, snapshotRevision }
}

/** The call is the agent's latest and its session and engine are still the same. */
function isCurrent(agentId: string, call: SpeedCall): boolean {
  const agent = useAgents.getState().agents[agentId]
  return (
    latestSpeedCall.get(agentId) === call.id &&
    agent?.engineGeneration === call.engineGeneration &&
    agent.snapshotRevision === call.snapshotRevision
  )
}

export async function readSpeed(agentId: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  const call = startSpeedCall(agent)
  let speed: SpeedState | undefined
  try {
    speed = await bridge.speed(agentId)
  } catch {
    // An engine that cannot report its speed (an older bridge, a model-less session): no control.
    // Engine 2 has no status of its own to correct it, so the previous model's control goes.
    if (agent.info.engine !== 'prime') return
  }
  if (isCurrent(agentId, call)) useAgents.getState().patchAgent(agentId, { speed })
}

/** Request `mode` for the session; the Engine also starts its new sessions at this speed. */
export async function setSpeed(agentId: string, mode: SpeedMode): Promise<boolean> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return false
  usePendingSpeed.setState({ [agentId]: mode })
  const call = startSpeedCall(agent)
  try {
    const speed = await bridge.speed(agentId, mode)
    if (isCurrent(agentId, call)) useAgents.getState().patchAgent(agentId, { speed })
    if (agent.info.engine === 'pi') {
      const { prefs, updateFeaturePrefs } = useApp.getState()
      updateFeaturePrefs('settings', { ...prefs.features.settings, speedDefault: mode })
    }
    return true
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not change the response speed',
      description: error instanceof Error ? error.message : String(error)
    })
    return false
  } finally {
    if (usePendingSpeed.getState()[agentId] === mode)
      usePendingSpeed.setState((pending) => {
        const next = { ...pending }
        delete next[agentId]
        return next
      }, true)
  }
}

/** Standard ⇄ Fast (palette). */
export function toggleFastMode(agentId: string): Promise<boolean> {
  const speed = useAgents.getState().agents[agentId]?.speed
  return setSpeed(agentId, speed && speed.effective !== 'standard' ? 'standard' : 'fast')
}

const FAST_ARGUMENTS = new Map<string, SpeedMode>([
  ['on', 'fast'],
  ['off', 'standard'],
  ['ultrafast', 'ultrafast']
])

/** `/fast [on|off|ultrafast]`: without an argument, toggles Fast. */
export async function runFastCommand(agentId: string, text: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  const argument = text.trim().toLowerCase()
  if (argument && !FAST_ARGUMENTS.has(argument)) {
    toast({ level: 'warning', title: 'Use /fast on, /fast off or /fast ultrafast' })
    return
  }
  if (!agent?.speed) {
    toast({ level: 'info', title: 'Fast mode is unavailable in this session' })
    return
  }
  const { speed } = agent
  const mode =
    FAST_ARGUMENTS.get(argument) ?? (speed.effective === 'standard' ? 'fast' : 'standard')
  const option = findSpeedOption(speed, mode)
  if (mode !== 'standard' && !option) {
    toast({
      level: 'info',
      title: `${SPEED_LABELS[mode]} is unavailable for this model`,
      description:
        speed.unavailableReason ??
        (speed.options.length === 0 && agent.model
          ? `${agent.model.name} has no faster mode.`
          : undefined)
    })
    return
  }
  if (!(await setSpeed(agentId, mode))) return
  toast({
    level: 'info',
    title: mode === 'standard' ? 'Fast mode off' : `${SPEED_LABELS[mode]} mode on`,
    description: formatSpeedPrice(option),
    duration: FAST_COMMAND_TOAST_MS
  })
}

/**
 * After a refusal new Engine sessions start at standard: refusals concern the account (no access,
 * no credits, project policy), so a faster default would fail their first turn too.
 */
function resetFasterDefault(): void {
  const { prefs, updateFeaturePrefs } = useApp.getState()
  const settings = prefs.features.settings
  if (settings?.speedDefault && settings.speedDefault !== 'standard')
    updateFeaturePrefs('settings', { ...settings, speedDefault: 'standard' })
}

/** What a speed read depends on; null while the session cannot answer one. */
function speedReadKey(agent: AgentState): string | null {
  if (agent.status !== 'ready' || agent.modelChangePending) return null
  // Engine 2 reports no speed of its own: re-read it for each model and attachment.
  if (agent.info.engine === 'prime') {
    const model = `${agent.model?.provider}/${agent.model?.id}`
    return `${agent.engineGeneration}:${agent.snapshotRevision}:${model}`
  }
  // The Engine publishes each session's speed itself; a read covers a switch it has not yet published.
  return agent.info.bridge ? `${agent.engineGeneration}:${agent.snapshotRevision}` : null
}

/** Read each session's speed when it can answer, and toast every provider notice once. */
export function startSpeedTracking(): () => void {
  const readKeys = new Map<string, string>()
  const shownNotices = new Map<string, string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const scheduleRead = (agentId: string) => {
    clearTimeout(timers.get(agentId))
    timers.set(
      agentId,
      setTimeout(() => {
        timers.delete(agentId)
        void readSpeed(agentId)
      }, SPEED_READ_DEBOUNCE_MS)
    )
  }

  const forget = (agentId: string) => {
    clearTimeout(timers.get(agentId))
    timers.delete(agentId)
    readKeys.delete(agentId)
    shownNotices.delete(agentId)
    latestSpeedCall.delete(agentId)
  }

  const unsubscribeAgents = useAgents.subscribe((state, previous) => {
    if (state.agents === previous.agents) return
    for (const agent of Object.values(state.agents)) {
      if (agent === previous.agents[agent.id]) continue
      const key = speedReadKey(agent)
      if (key !== null && readKeys.get(agent.id) !== key) {
        readKeys.set(agent.id, key)
        scheduleRead(agent.id)
      }
      const notice = agent.speed?.notice
      if (!notice) continue
      // Notice ids restart with each engine process.
      const noticeKey = `${agent.engineGeneration}:${notice.id}`
      if (shownNotices.get(agent.id) === noticeKey) continue
      shownNotices.set(agent.id, noticeKey)
      toast({ level: 'warning', title: 'Speed set to Standard', description: notice.text })
      if (agent.info.engine === 'pi') resetFasterDefault()
    }
    if (state.order === previous.order) return
    for (const agentId of new Set([...readKeys.keys(), ...shownNotices.keys()]))
      if (!state.agents[agentId]) forget(agentId)
  })

  const unsubscribeEvents = on('engine:event', ({ agentId, event }) => {
    if (event.type === 'engine_native_event' && event.name === 'service_tier_changed')
      scheduleRead(agentId)
  })

  return () => {
    unsubscribeAgents()
    unsubscribeEvents()
    for (const agentId of [...timers.keys()]) forget(agentId)
  }
}
