import {
  asRecord,
  PrimeCommandError,
  stringValue,
  type PrimeRecord,
  type PrimeTransport
} from './transport'

const TERMINAL_SIDE_QUESTION_STATES = new Set(['complete', 'error', 'cancelled'])
const sideQuestions = new Map<string, Map<string, Set<PrimeDaemonActivity>>>()
const handoffGuards = new Map<string, number>()

export function guardPrimeHandoff(socketPath: string): { assertIdle(): void; release(): void } {
  const assertIdle = (): void => {
    if (sideQuestions.get(socketPath)?.size) {
      throw new Error('Wait for Engine 2 side questions to finish before switching engines')
    }
  }
  assertIdle()
  handoffGuards.set(socketPath, (handoffGuards.get(socketPath) ?? 0) + 1)
  let released = false
  return {
    assertIdle,
    release() {
      if (released) return
      released = true
      const remaining = (handoffGuards.get(socketPath) ?? 1) - 1
      if (remaining) handoffGuards.set(socketPath, remaining)
      else handoffGuards.delete(socketPath)
    }
  }
}

export function assertPrimeSideQuestionsIdle(socketPath: string): void {
  if (sideQuestions.get(socketPath)?.size) {
    throw new Error('Wait for Engine 2 side questions to finish before restarting its runtime')
  }
}

export class PrimeDaemonActivity {
  private readonly questions = new Set<string>()

  constructor(
    private readonly client: PrimeTransport,
    private readonly restarting: () => boolean = () => false
  ) {
    client.on('event', (frame) => this.observe(frame))
    client.on('close', () => {
      for (const key of [...this.questions]) this.forget(key)
    })
  }

  async request(
    type: string,
    payload: PrimeRecord,
    send: () => Promise<PrimeRecord>
  ): Promise<PrimeRecord> {
    const starting = type === 'start_side_question'
    if (starting && !this.client.connected) throw new Error('Engine 2 is disconnected')
    if (starting && this.restarting()) {
      throw new Error('Engine 2 is restarting; ask the side question after it reconnects')
    }
    if (starting && handoffGuards.has(this.client.socketPath)) {
      throw new Error('Engine 2 is switching engines; ask the side question after it finishes')
    }
    const key = starting ? questionKey(payload.activeSessionId, payload.sideQuestionId) : undefined
    const tracked = key ? this.questions.has(key) : false
    if (key) this.remember(key)
    try {
      const result = await send()
      if (type === 'detach') this.forgetSession(payload.activeSessionId)
      return result
    } catch (error) {
      if (key && !tracked && error instanceof PrimeCommandError) this.forget(key)
      throw error
    }
  }

  private observe(frame: PrimeRecord): void {
    if (frame.type === 'session_binding') {
      this.forgetSession(frame.previousActiveSessionId)
      return
    }
    if (frame.type === 'session_closed') {
      this.forgetSession(frame.activeSessionId)
      return
    }
    if (frame.type !== 'side_question_event') return
    const event = asRecord(frame.event)
    const key = questionKey(frame.activeSessionId, event.id)
    if (!key) return
    if (event.status === 'running') this.remember(key)
    else if (TERMINAL_SIDE_QUESTION_STATES.has(String(event.status))) {
      const observers = sideQuestions.get(this.client.socketPath)?.get(key)
      for (const observer of [...(observers ?? [])]) observer.forget(key)
    }
  }

  private remember(key: string): void {
    this.questions.add(key)
    let active = sideQuestions.get(this.client.socketPath)
    if (!active) {
      active = new Map()
      sideQuestions.set(this.client.socketPath, active)
    }
    let observers = active.get(key)
    if (!observers) {
      observers = new Set()
      active.set(key, observers)
    }
    observers.add(this)
  }

  private forget(key: string): void {
    this.questions.delete(key)
    const active = sideQuestions.get(this.client.socketPath)
    const observers = active?.get(key)
    observers?.delete(this)
    if (!observers?.size) active?.delete(key)
    if (!active?.size) sideQuestions.delete(this.client.socketPath)
  }

  private forgetSession(activeSessionId: unknown): void {
    if (typeof activeSessionId !== 'string') return
    for (const key of [...this.questions]) {
      if (key.startsWith(`${activeSessionId}\0`)) this.forget(key)
    }
  }
}

function questionKey(activeSessionId: unknown, sideQuestionId: unknown): string | undefined {
  const session = stringValue(activeSessionId)
  const question = stringValue(sideQuestionId)
  return session && question ? `${session}\0${question}` : undefined
}
