import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { EngineStatus } from '@shared/api/engine'
import type {
  EngineEvent,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse
} from '@shared/engine-types'
import { Emitter, defaultTimeout, type EngineHandle, type EngineHandleEvents, type SendOptions } from './handle'
import type { EngineLocation } from './locate'
import { engineEnv, killProcessTree, OWN_PROCESS_GROUP } from './runtime'
import { flattenTreeResponse, type EngineTreeResponse } from './session-tree'

/**
 * Strict LF JSONL decoder: splits only on `\n` and strips one trailing `\r`.
 * Deliberately not `readline`, which also splits on U+2028/U+2029 (valid inside JSON strings).
 * Each chunk is scanned once and partial-line pieces are joined only when their `\n` arrives, so a
 * multi-MB record (e.g. get_messages with images) costs linear time.
 */
export class JsonlDecoder {
  private decoder = new StringDecoder('utf8')
  private partial: string[] = []

  push(chunk: Buffer): string[] {
    const text = this.decoder.write(chunk)
    const lines: string[] = []
    let start = 0
    let index = text.indexOf('\n')
    while (index !== -1) {
      let line = text.slice(start, index)
      if (this.partial.length > 0) {
        this.partial.push(line)
        line = this.partial.join('')
        this.partial = []
      }
      this.emitLine(line, lines)
      start = index + 1
      index = text.indexOf('\n', start)
    }
    if (start < text.length) this.partial.push(text.slice(start))
    return lines
  }

  /** Remaining partial record at stream end (pi always terminates records, so normally empty). */
  end(): string[] {
    const rest = this.partial.join('') + this.decoder.end()
    this.partial = []
    const lines: string[] = []
    this.emitLine(rest, lines)
    return lines
  }

  private emitLine(line: string, out: string[]): void {
    const record = line.endsWith('\r') ? line.slice(0, -1) : line
    if (record.length > 0) out.push(record)
  }
}

/** Bounded stderr capture (diagnostics only, never parsed as protocol). */
export class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly maxChars: number) {}

  push(text: string): void {
    this.chunks.push(text)
    this.size += text.length
    while (this.size > this.maxChars && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length
    }
  }

  toString(): string {
    const all = this.chunks.join('')
    return all.length > this.maxChars ? all.slice(all.length - this.maxChars) : all
  }

  tail(chars: number): string {
    const all = this.toString()
    return all.slice(Math.max(0, all.length - chars))
  }
}

export class EngineProcessError extends Error {
  constructor(
    message: string,
    readonly code: 'timeout' | 'exited' | 'not-running' | 'spawn'
  ) {
    super(message)
    this.name = 'EngineProcessError'
  }
}

interface Pending {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  command: string
}

export interface EngineProcessOptions {
  location: EngineLocation
  cwd: string
  /** CLI args after `--mode rpc`. */
  args: string[]
  /** Extra environment (merged over the children's base env, shell-env.ts). */
  env?: Record<string, string>
  /** Time allowed for pi to start and answer the initial get_state. */
  startupTimeoutMs?: number
}

const STDERR_CAPACITY = 256 * 1024
/** How long stop() lets a busy pi abort its run (and kill its tool processes) before killing the whole tree. */
const STOP_ABORT_TIMEOUT_MS = 2000

/** One `pi --mode rpc` child process with id-correlated requests and forwarded events. */
export class EngineProcess implements EngineHandle {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly emitter = new Emitter<EngineHandleEvents>()
  private readonly pending = new Map<string, Pending>()
  private readonly stderrBuffer = new RingBuffer(STDERR_CAPACITY)
  private readonly writeQueue: string[] = []
  private draining = false
  private counter = 0
  private stopping = false
  /** Between agent_start and agent_settled: tools may be running as pi's child processes. */
  private agentRunning = false
  private exitPromise: Promise<void> | null = null
  private _status: EngineStatus = 'starting'
  private _error: string | undefined

  constructor(private readonly options: EngineProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  get status(): EngineStatus {
    return this._status
  }

  get error(): string | undefined {
    return this._error
  }

  on<K extends keyof EngineHandleEvents>(event: K, listener: (payload: EngineHandleEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  stderr(): string {
    return this.stderrBuffer.toString()
  }

  async start(): Promise<void> {
    const { location, cwd, args } = this.options
    this.setStatus('starting')
    const child = spawn(location.node.path, [location.cliPath, '--mode', 'rpc', ...args], {
      cwd,
      env: engineEnv(location, this.options.env),
      windowsHide: true,
      detached: OWN_PROCESS_GROUP,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child

    const decoder = new JsonlDecoder()
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) this.handleLine(line)
    })
    child.stdout.on('end', () => {
      for (const line of decoder.end()) this.handleLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => this.stderrBuffer.push(text))
    const stderrEnded = new Promise<void>((resolve) => child.stderr.once('close', () => resolve()))
    child.stdin.on('drain', () => this.flushWrites())
    // EPIPE after the child died is reported through 'exit'; swallow it here.
    child.stdin.on('error', () => undefined)

    this.exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        this.handleExit(code, signal)
        resolve()
      })
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (error) => {
        this._error = `Could not start the engine: ${error.message}`
        this.setStatus('crashed')
        reject(new EngineProcessError(this._error, 'spawn'))
      })
    })

    // The first response proves the protocol is alive (pi answers after loading extensions).
    let response: RpcResponse
    try {
      response = await this.send({ type: 'get_state' }, { timeoutMs: this.options.startupTimeoutMs ?? 90_000 })
    } catch (error) {
      // pi reports startup failures (e.g. an extension that fails to load) on stderr before exiting;
      // 'exit' can fire before stderr is drained, so let callers inspect the complete output.
      if (error instanceof EngineProcessError && error.code === 'exited') {
        await Promise.race([stderrEnded, new Promise((resolve) => setTimeout(resolve, 1000))])
      }
      throw error
    }
    if (!response.success) {
      this._error = response.error
      throw new EngineProcessError(`Engine failed to start: ${response.error}`, 'spawn')
    }
    if (this._status === 'starting') this.setStatus('ready')
  }

  send(command: RpcCommand, options: SendOptions = {}): Promise<RpcResponse> {
    const child = this.child
    if (!child || this._status === 'crashed' || this._status === 'exited' || this.stopping) {
      return Promise.reject(new EngineProcessError('Engine is not running', 'not-running'))
    }
    // Callers may supply their own id to correlate streamed events (bash_execution_update).
    const id = command.id ?? `v-${++this.counter}`
    if (this.pending.has(id)) return Promise.reject(new Error(`Duplicate command id ${id}`))
    const timeoutMs = options.timeoutMs ?? defaultTimeout(command.type)
    return new Promise<RpcResponse>((resolve, reject) => {
      const pending: Pending = { resolve, reject, timer: null, command: command.type }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new EngineProcessError(`Engine did not answer "${command.type}" within ${Math.round(timeoutMs / 1000)}s`, 'timeout'))
        }, timeoutMs)
      }
      this.pending.set(id, pending)
      this.write({ ...command, id })
    })
  }

  respondUi(response: RpcExtensionUIResponse): void {
    if (!this.child || this.stopping) return
    this.write(response)
  }

  async stop(graceMs = 3000): Promise<void> {
    const child = this.child
    if (!child || this._status === 'exited' || this._status === 'crashed') return
    // A running tool (bash, an MCP call, a sub-agent) is a child of pi. Once pi exits on stdin close, Windows can no
    // longer reach those orphans through pi's tree, so a busy pi aborts first (it kills its own tool processes); if
    // it cannot, the tree is killed while pi still anchors it.
    if (this.busy && !(await this.abortForStop())) killProcessTree(child)
    this.stopping = true
    this.setStatus('stopping')
    child.stdin.end()
    const exited = this.exitPromise ?? Promise.resolve()
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs))
    ])
    if (timedOut) {
      killProcessTree(child)
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
  }

  /** A `!command` (RPC `bash`) is still running. */
  private get bashRunning(): boolean {
    return [...this.pending.values()].some((pending) => pending.command === 'bash')
  }

  private get busy(): boolean {
    return this.agentRunning || this.bashRunning
  }

  /** Abort the agent run and any `!command`; true when pi confirmed both in time. */
  private async abortForStop(): Promise<boolean> {
    const commands: RpcCommand[] = [{ type: 'abort' }]
    if (this.bashRunning) commands.push({ type: 'abort_bash' })
    try {
      const responses = await Promise.all(commands.map((command) => this.send(command, { timeoutMs: STOP_ABORT_TIMEOUT_MS })))
      return responses.every((response) => response.success)
    } catch {
      return false
    }
  }

  private write(record: RpcCommand | RpcExtensionUIResponse): void {
    const line = `${JSON.stringify(record)}\n`
    if (this.draining) {
      this.writeQueue.push(line)
      return
    }
    const ok = this.child!.stdin.write(line)
    if (!ok) this.draining = true
  }

  private flushWrites(): void {
    this.draining = false
    while (this.writeQueue.length > 0 && this.child) {
      const ok = this.child.stdin.write(this.writeQueue.shift()!)
      if (!ok) {
        this.draining = true
        return
      }
    }
  }

  private handleLine(line: string): void {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      // stdout is reserved for protocol; anything else is diagnostics.
      this.stderrBuffer.push(`[stdout] ${line}\n`)
      return
    }
    if (!record || typeof record !== 'object') return
    const typed = record as { type?: unknown; id?: unknown }
    if (typed.type === 'response') {
      const id = typeof typed.id === 'string' ? typed.id : undefined
      const pending = id ? this.pending.get(id) : undefined
      if (pending && id) {
        this.pending.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        pending.resolve(pending.command === 'get_tree' ? flattenTreeResponse(record as EngineTreeResponse) : (record as RpcResponse))
      } else {
        // Uncorrelated response (e.g. parse error); keep it visible in diagnostics.
        this.stderrBuffer.push(`[uncorrelated response] ${line}\n`)
      }
      return
    }
    const event = record as EngineEvent
    if (event.type === 'agent_start') this.agentRunning = true
    else if (event.type === 'agent_settled') this.agentRunning = false
    this.emitter.emit('event', event)
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = this.stopping
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new EngineProcessError(`Engine exited before answering "${pending.command}"`, 'exited'))
      this.pending.delete(id)
    }
    this.writeQueue.length = 0
    if (!expected && !this._error) {
      const tail = this.stderrBuffer.tail(600).trim()
      this._error = `Engine exited unexpectedly (code ${code ?? 'none'}${signal ? `, ${signal}` : ''})${tail ? `: ${tail}` : ''}`
    }
    this.setStatus(expected ? 'exited' : 'crashed')
    this.emitter.emit('exit', { code, signal, expected })
  }

  private setStatus(status: EngineStatus): void {
    if (this._status === status) return
    this._status = status
    this.emitter.emit('status', status)
  }
}
