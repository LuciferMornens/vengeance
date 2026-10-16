import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { Emitter } from '../handle'
import { JsonlDecoder } from '../rpc-process'

export type PrimeRecord = Record<string, unknown>

export function asRecord(value: unknown): PrimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as PrimeRecord)
    : {}
}

export function asRecords(value: unknown): PrimeRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export class PrimeCommandError extends Error {
  constructor(
    message: string,
    readonly details: PrimeRecord = {}
  ) {
    super(message)
    this.name = 'PrimeCommandError'
  }
}

interface TransportEvents {
  event: PrimeRecord
  close: { expected: boolean; error?: string }
}

interface PendingRequest {
  resolve(value: PrimeRecord): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

const PROTOCOL_NAME = 'prime-agent.daemon'
const PROTOCOL_VERSION = 7
const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000

export class PrimeTransport extends Emitter<TransportEvents> {
  private socket: Socket | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private expectedClose = false
  private closed = false
  private draining = false
  private writeChain = Promise.resolve()
  private helloRecord: PrimeRecord = {}

  constructor(readonly socketPath: string) {
    super()
  }

  get hello(): PrimeRecord {
    return this.helloRecord
  }

  get connected(): boolean {
    return !!this.socket && !this.closed && !this.draining
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.socket) throw new Error('Engine 2 connection has already been opened')
    const decoder = new JsonlDecoder()
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      this.socket = socket
      const timer = setTimeout(() => {
        const error = new Error('Engine 2 did not complete its connection handshake')
        socket.destroy(error)
      }, timeoutMs)
      let handshaken = false
      socket.on('data', (chunk: Buffer) => {
        for (const line of decoder.push(chunk)) {
          if (!line.trim()) continue
          let frame: PrimeRecord
          try {
            frame = asRecord(JSON.parse(line))
          } catch {
            socket.destroy(new Error('Engine 2 returned an invalid protocol frame'))
            return
          }
          if (!handshaken && frame.type === 'daemon_hello') {
            const protocol = asRecord(frame.protocol)
            if (protocol.name !== PROTOCOL_NAME || protocol.version !== PROTOCOL_VERSION) {
              socket.destroy(new Error('This Engine 2 protocol version is not supported'))
              return
            }
            handshaken = true
            this.helloRecord = frame
            clearTimeout(timer)
            resolve()
          } else {
            this.receive(frame)
          }
        }
      })
      socket.on('error', (error) => {
        clearTimeout(timer)
        if (!handshaken) reject(error)
        this.fail(error)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        const error = new Error('Engine 2 disconnected')
        if (!handshaken) reject(error)
        this.fail(error)
      })
    })
  }

  request(
    type: string,
    payload: PrimeRecord = {},
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<PrimeRecord> {
    if (!this.socket || this.closed || this.draining)
      return Promise.reject(new Error('Engine 2 is disconnected'))
    const commandId = `v-${randomUUID()}`
    return new Promise<PrimeRecord>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(commandId)
          reject(new Error(`Engine 2 timed out while running ${type.replaceAll('_', ' ')}`))
          if (this.draining && this.pending.size === 0) this.close()
        }, timeoutMs)
      }
      this.pending.set(commandId, pending)
      const frame = {
        type: 'command',
        id: commandId,
        clientId: this.helloRecord.clientId,
        protocol: this.helloRecord.protocol,
        command: { ...payload, type }
      }
      this.writeChain = this.writeChain
        .then(() => this.write(`${JSON.stringify(frame)}\n`))
        .catch((error: unknown) => {
          this.rejectPending(commandId, error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  close(): void {
    this.expectedClose = true
    this.socket?.destroy()
    this.fail(new Error('Engine 2 connection closed'))
  }

  closeWhenIdle(): void {
    this.draining = true
    if (this.pending.size === 0) this.close()
  }

  private async write(line: string): Promise<void> {
    const socket = this.socket
    if (!socket || this.closed) throw new Error('Engine 2 is disconnected')
    await new Promise<void>((resolve, reject) => {
      socket.write(line, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private receive(frame: PrimeRecord): void {
    if (frame.type === 'event') {
      this.receive(asRecord(frame.event))
      return
    }
    if (frame.type !== 'response') {
      this.emit('event', frame)
      return
    }
    const commandId = stringValue(frame.id)
    const pending = commandId ? this.pending.get(commandId) : undefined
    if (!pending || !commandId) return
    this.pending.delete(commandId)
    clearTimeout(pending.timer)
    if (frame.success === true) {
      pending.resolve(asRecord(frame.data))
    } else {
      pending.reject(
        new PrimeCommandError(
          stringValue(frame.error) ?? 'Engine 2 could not complete the command',
          asRecord(frame.errorInfo)
        )
      )
    }
    const acknowledgement = {
      type: 'command',
      id: `ack-${commandId}`,
      clientId: this.helloRecord.clientId,
      protocol: this.helloRecord.protocol,
      command: { type: 'ack_result', commandId }
    }
    this.writeChain = this.writeChain
      .then(() => this.write(`${JSON.stringify(acknowledgement)}\n`))
      .catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      })
    if (this.draining && this.pending.size === 0) this.close()
  }

  private rejectPending(commandId: string, error: Error): void {
    const pending = this.pending.get(commandId)
    if (!pending) return
    this.pending.delete(commandId)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const commandId of this.pending.keys()) this.rejectPending(commandId, error)
    this.emit('close', { expected: this.expectedClose, error: error.message })
  }
}
