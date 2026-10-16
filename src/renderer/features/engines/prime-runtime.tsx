import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke, on } from '../../lib/ipc'

interface PrimeCommandPayloads {
  get_state: Record<string, never>
  prompt_and_wait: { message: string }
  get_messages: Record<string, never>
  get_context_tree: Record<string, never>
  get_system_prompt: Record<string, never>
  get_rlm_children: Record<string, never>
  get_rlm_max_depth_status: Record<string, never>
  set_rlm_max_depth: { maxDepth: number; global?: boolean }
  cancel_rlm_child: { childId: string }
  delete_rlm_subagent: { childId: string }
  send_message: { targetActiveSessionId: string; message: string }
  heartbeat_get: Record<string, never>
  heartbeats_list: Record<string, never>
  heartbeat_set: { schedule: string; prompt: string; deliveryMode: 'steer' | 'follow_up' }
  heartbeat_update: { action: 'pause' | 'resume' | 'stop' | 'clear' }
  heartbeat_manage: {
    jobId: string
    activeSessionId: string
    action: 'pause' | 'resume' | 'stop'
  }
  cron_list: { includeInactive?: boolean }
  cron_add: { schedule: string; prompt: string }
  cron_cancel: { jobId: string }
  refine: { instructions?: string; rollbackId?: string; global?: boolean }
  set_service_tier: { serviceTier: string }
  start_side_question: {
    sideQuestionId: string
    question: string
    previousTurns?: Array<{ question: string; answer: string }>
  }
  abort_side_question: { sideQuestionId: string }
  factory_activity: {
    action: 'graph' | 'status' | 'watch' | 'run' | 'stop' | 'resume'
    runId?: string
    specId?: string
    timeoutMs?: number
  }
  kill: Record<string, never>
}

export async function primeCommand<Command extends keyof PrimeCommandPayloads>(
  agentId: string,
  command: Command,
  payload: PrimeCommandPayloads[Command]
): Promise<unknown> {
  return invoke('prime:command', agentId, command, payload)
}

export function nativeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function nativeText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function nativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function nativeRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(nativeRecord) : []
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type PrimeQuery =
  | 'get_state'
  | 'get_messages'
  | 'get_context_tree'
  | 'get_system_prompt'
  | 'get_rlm_children'
  | 'get_rlm_max_depth_status'
  | 'heartbeat_get'
  | 'heartbeats_list'
  | 'cron_list'

const PANEL_REFRESH_EVENTS = new Set([
  'goal_update',
  'autonomous_status',
  'rlm_child_update',
  'heartbeats_changed'
])

export function usePrimeQuery(agentId: string, command: PrimeQuery) {
  const [data, setData] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await primeCommand(agentId, command, {})
      if (request === generation.current) setData(result)
    } catch (cause) {
      if (request === generation.current) setError(errorText(cause))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [agentId, command])

  useEffect(() => {
    void reload()
    const unsubscribe = on('engine:event', ({ agentId: source, event }) => {
      if (source !== agentId) return
      const refresh =
        event.type === 'agent_end' ||
        (event.type === 'message_end' && event.message.role === 'custom') ||
        (event.type === 'engine_native_event' && PANEL_REFRESH_EVENTS.has(event.name))
      if (refresh) void reload()
    })
    return () => {
      generation.current += 1
      unsubscribe()
    }
  }, [agentId, reload])

  return { data, loading, error, reload }
}

export function usePrimeAction() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const perform = async (operation: () => Promise<unknown>, success?: string): Promise<boolean> => {
    if (pending) return false
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await operation()
      if (success) setNotice(success)
      return true
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      setPending(false)
    }
  }
  return { pending, error, notice, perform }
}

export function PrimeFeedback({
  error,
  notice
}: {
  error?: string | null
  notice?: string | null
}) {
  return (
    <>
      {error && (
        <p role="alert" className="my-3 text-sm leading-relaxed text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="my-3 text-sm leading-relaxed text-fg-2">
          {notice}
        </p>
      )}
    </>
  )
}

export function PrimeFormField({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-fg-2">{label}</div>
      {children}
      {hint && <p className="text-xs leading-relaxed text-fg-3">{hint}</p>}
    </div>
  )
}
