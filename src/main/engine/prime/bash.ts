import { randomUUID } from 'node:crypto'
import type { BashResult, EngineEvent, RpcCommandOf } from '@shared/engine-types'
import { asRecords, stringValue, type PrimeRecord } from './transport'

type NativeRequest = (
  type: string,
  payload?: PrimeRecord,
  timeoutMs?: number
) => Promise<PrimeRecord>

interface PendingBash {
  runId: string
  started: boolean
  resolve: (event: PrimeRecord) => void
  reject: (error: Error) => void
}

export class PrimeBashRunner {
  private pending: PendingBash | undefined

  constructor(private readonly emit: (event: EngineEvent) => void) {}

  async run(
    command: RpcCommandOf<'bash'> & { id?: string },
    request: NativeRequest,
    timeoutMs: number
  ): Promise<BashResult> {
    if (this.pending) throw new Error('A shell command is already running')
    const runId = command.id ?? randomUUID()
    const startedAt = Date.now()
    const completion = new Promise<PrimeRecord>((resolve, reject) => {
      this.pending = { runId, started: false, resolve, reject }
    })
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => this.disconnect('Engine 2 shell command timed out'), timeoutMs)
        : undefined
    try {
      const [, end] = await Promise.all([
        request(
          'execute_bash',
          {
            command: command.command,
            excludeFromContext: command.excludeFromContext,
            runId
          },
          timeoutMs
        ),
        completion
      ])
      if (typeof end.errorMessage === 'string') throw new Error(end.errorMessage)

      // bash_end omits output; the native durable row owns truncation and spill metadata.
      const history = await request('get_messages')
      const message = asRecords(history.messages).findLast(
        (entry) =>
          entry.role === 'bashExecution' &&
          entry.command === command.command &&
          typeof entry.timestamp === 'number' &&
          entry.timestamp >= startedAt
      )
      if (!message) throw new Error('Engine 2 did not return the completed shell command')
      return {
        output: stringValue(message.output) ?? '',
        exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined,
        cancelled: message.cancelled === true,
        truncated: message.truncated === true,
        fullOutputPath: stringValue(message.fullOutputPath)
      }
    } finally {
      clearTimeout(timeout)
      this.pending = undefined
    }
  }

  accept(event: PrimeRecord): void {
    const pending = this.pending
    if (!pending) return
    if (event.type === 'bash_start' && event.runId === pending.runId) {
      pending.started = true
    } else if (event.type === 'bash_output' && pending.started) {
      // Native output chunks omit runId; execute_bash owns a single session-wide slot.
      this.emit({
        type: 'bash_execution_update',
        id: pending.runId,
        delta: stringValue(event.chunk) ?? ''
      })
    } else if (event.type === 'bash_end' && event.runId === pending.runId) {
      pending.started = false
      pending.resolve(event)
    }
  }

  disconnect(message = 'Engine 2 disconnected during the shell command'): void {
    this.pending?.reject(new Error(message))
  }
}
