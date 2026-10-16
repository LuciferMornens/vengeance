import { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import { create } from 'zustand'
import type { AssistantMessage } from '@shared/engine-types'
import { on } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { Checkbox, Tooltip, toast } from '../../ui'

interface SpeedSamples {
  outputTokens: number
  durationMs: number
  count: number
  latestRate?: number
  latestResponse?: string
}

interface TokenSpeedState {
  sessions: Record<string, SpeedSamples>
}

const useTokenSpeed = create<TokenSpeedState>(() => ({ sessions: {} }))
const MILLISECONDS_PER_SECOND = 1000
const WHOLE_NUMBER_RATE = 100

function emptySamples(): SpeedSamples {
  return { outputTokens: 0, durationMs: 0, count: 0 }
}

function recordSample(agentId: string, message: AssistantMessage): void {
  const sample = useTokenSpeed.getState().sessions[agentId]
  if (!sample || message.stopReason === 'aborted' || message.stopReason === 'error') return
  const durationMs = Date.now() - message.timestamp
  const outputTokens = message.usage.output
  const response = message.responseId ?? `${message.provider}:${message.model}:${message.timestamp}`
  if (
    !Number.isFinite(message.timestamp) ||
    message.timestamp <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0 ||
    response === sample.latestResponse
  )
    return

  useTokenSpeed.setState((state) => ({
    sessions: {
      ...state.sessions,
      [agentId]: {
        outputTokens: sample.outputTokens + outputTokens,
        durationMs: sample.durationMs + durationMs,
        count: sample.count + 1,
        latestRate: outputTokens / (durationMs / MILLISECONDS_PER_SECOND),
        latestResponse: response
      }
    }
  }))
}

let stopTracking: (() => void) | undefined

function updateTracking(): void {
  const enabled = Object.keys(useTokenSpeed.getState().sessions).length > 0
  if (!enabled) {
    stopTracking?.()
    stopTracking = undefined
    return
  }
  if (stopTracking) return

  const unsubscribeEvents = on('engine:event', ({ agentId, event }) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      recordSample(agentId, event.message)
    }
  })
  const unsubscribeAgents = useAgents.subscribe((current, previous) => {
    const sessions = useTokenSpeed.getState().sessions
    let next = sessions
    for (const agentId of Object.keys(sessions)) {
      const agent = current.agents[agentId]
      const prior = previous.agents[agentId]
      const changedSession =
        prior &&
        (agent?.engineGeneration !== prior.engineGeneration ||
          (prior.session?.sessionId && agent?.session?.sessionId !== prior.session.sessionId))
      if (agent && !changedSession) continue
      if (next === sessions) next = { ...sessions }
      if (agent) next[agentId] = emptySamples()
      else delete next[agentId]
    }
    if (next !== sessions) {
      useTokenSpeed.setState({ sessions: next })
      updateTracking()
    }
  })
  stopTracking = () => {
    unsubscribeEvents()
    unsubscribeAgents()
  }
}

export function setTokenSpeedDisplay(agentId: string, enabled: boolean): void {
  if (!useAgents.getState().agents[agentId]) return
  const sessions = { ...useTokenSpeed.getState().sessions }
  if (enabled) sessions[agentId] ??= emptySamples()
  else delete sessions[agentId]
  useTokenSpeed.setState({ sessions })
  updateTracking()
}

export function runTokenSpeedCommand(agentId: string, text: string): void {
  const argument = text.trim().toLowerCase()
  if (argument && argument !== 'on' && argument !== 'off') {
    toast({ level: 'warning', title: 'Use /speed on or /speed off' })
    return
  }
  const enabled = argument ? argument === 'on' : !useTokenSpeed.getState().sessions[agentId]
  setTokenSpeedDisplay(agentId, enabled)
  toast({
    level: 'info',
    title: enabled ? 'Token speed display on' : 'Token speed display off',
    description: enabled
      ? 'The footer shows response output tokens per second and a session average.'
      : undefined
  })
}

function formatRate(rate: number): string {
  return rate.toFixed(rate >= WHOLE_NUMBER_RATE ? 0 : 1)
}

export function TokenSpeedSetting({ agentId }: { agentId: string }) {
  const enabled = useTokenSpeed((state) => !!state.sessions[agentId])
  return (
    <label className="flex items-center justify-between gap-4 border-b border-hairline-soft py-5">
      <span>
        <span className="block text-sm font-medium text-fg">Token speed in composer</span>
        <span className="mt-1 block text-xs leading-relaxed text-fg-3">
          Show output tokens per second and the average for this session. Turning it off resets the
          average.
        </span>
      </span>
      <Checkbox checked={enabled} onCheckedChange={(next) => setTokenSpeedDisplay(agentId, next)} />
    </label>
  )
}

function SpeedReadout({ agentId, sample }: { agentId: string; sample: SpeedSamples }) {
  const startedAt = useAgents((state) => {
    const message = state.agents[agentId]?.streaming?.message
    return message?.role === 'assistant' ? message.timestamp : undefined
  })
  const liveOutput = useAgents((state) => {
    const message = state.agents[agentId]?.streaming?.message
    return message?.role === 'assistant' ? message.usage.output : 0
  })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), MILLISECONDS_PER_SECOND)
    return () => window.clearInterval(timer)
  }, [startedAt])

  const durationMs = startedAt === undefined ? 0 : now - startedAt
  const liveRate =
    Number.isFinite(liveOutput) && liveOutput > 0 && durationMs > 0
      ? liveOutput / (durationMs / MILLISECONDS_PER_SECOND)
      : undefined
  const average = sample.count
    ? sample.outputTokens / (sample.durationMs / MILLISECONDS_PER_SECOND)
    : undefined
  const rate = liveRate ?? sample.latestRate
  const description =
    startedAt !== undefined
      ? liveRate === undefined
        ? 'Waiting for the provider’s output token count. The average includes completed responses.'
        : 'Live output tokens per second. The average includes completed responses.'
      : 'Latest response output tokens per second and the average since enabling this display.'

  return (
    <Tooltip content={`${description} Click to turn off.`}>
      <button
        type="button"
        onClick={() => setTokenSpeedDisplay(agentId, false)}
        aria-label="Turn off token speed display"
        className="pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs whitespace-nowrap tabular-nums text-fg-3 hover:bg-hover hover:text-fg-2 @max-[40em]/composer:hidden"
      >
        <Gauge className="size-3.5" />
        {rate === undefined ? 'Speed: waiting' : `${formatRate(rate)} tok/s`}
        {average !== undefined && sample.count > 1 && (
          <span className="@max-[52em]/composer:hidden">· avg {formatRate(average)}</span>
        )}
      </button>
    </Tooltip>
  )
}

export function TokenSpeed({ agentId }: { agentId: string }) {
  const sample = useTokenSpeed((state) => state.sessions[agentId])
  return sample ? <SpeedReadout agentId={agentId} sample={sample} /> : null
}
