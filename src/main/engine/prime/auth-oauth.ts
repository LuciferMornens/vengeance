import { shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type {
  AuthFlowEvent,
  AuthFlowNotice,
  AuthFlowPrompt,
  AuthMethod,
  JsonObject,
  StartLoginArgs
} from '@shared/api/settings'
import { samePath } from '../../paths'
import { childBaseEnv, shellEnvironmentReady } from '../../shell-env'
import { jsonObject, updatePrimeJson } from './configuration-store'
import { primeHelperPath } from './helper'
import { getPrimeAgentDir } from './locate'

const HELPER_PROTOCOL = 1
const HELPER_REVISION = '8aac8692456c00c01d4e53e60e6d3347a3506559'
const START_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 20 * 60_000
const HELPER_STOP_TIMEOUT_MS = 1_000
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_REPLY_BYTES = 60 * 1024
const MAX_NOTICE_LENGTH = 4_096
const AUTH_FLOW_PROVIDERS = new Set([
  'anthropic',
  'github-copilot',
  'openai-codex',
  'xai',
  'prime-inference',
  'prime-agent-traces'
])
const API_KEY_FLOW_PROVIDERS = new Set(['prime-inference', 'prime-agent-traces'])
const OPTIONAL_CREDENTIAL_FIELDS = [
  'accountId',
  'enterpriseUrl',
  'endpoint',
  'tokenEndpoint',
  'clientId',
  'resource',
  'issuer',
  'audienceMode'
]

type LoginPhase = 'starting' | 'running' | 'saving' | 'done'
type EmitAuth = (event: AuthFlowEvent) => void

interface LoginOptions {
  cwd?: string
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_NOTICE_LENGTH ? value : undefined
}

function requiredText(value: unknown): string {
  const text = optionalText(value)
  if (!text) throw new Error('The sign-in helper returned an invalid message.')
  return text
}

function authorizationUrl(value: unknown): string {
  const url = new URL(requiredText(value))
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new Error('The sign-in helper returned an invalid authorization URL.')
  }
  return url.href
}

function parsePrompt(value: unknown): AuthFlowPrompt {
  const prompt = jsonObject(value)
  if (!prompt) throw new Error('The sign-in helper returned an invalid prompt.')
  const message = requiredText(prompt.message)
  if (prompt.type === 'select') {
    if (!Array.isArray(prompt.options)) throw new Error('The account choices could not be read.')
    const options = prompt.options.map((value) => {
      const option = jsonObject(value)
      if (!option) throw new Error('The account choices could not be read.')
      return {
        id: requiredText(option.id),
        label: requiredText(option.label),
        description: optionalText(option.description)
      }
    })
    return { type: 'select', message, options }
  }
  if (prompt.type !== 'text' && prompt.type !== 'secret' && prompt.type !== 'manual_code') {
    throw new Error('The sign-in helper requested an unsupported prompt.')
  }
  return { type: prompt.type, message, placeholder: optionalText(prompt.placeholder) }
}

function parseNotice(value: unknown): AuthFlowNotice {
  const notice = jsonObject(value)
  if (!notice) throw new Error('The sign-in helper returned an invalid notice.')
  if (notice.type === 'auth_url') {
    return {
      type: 'auth_url',
      url: authorizationUrl(notice.url),
      instructions: optionalText(notice.instructions)
    }
  }
  if (notice.type === 'device_code') {
    const userCode = requiredText(notice.userCode)
    if (!/^[A-Za-z0-9-]+$/.test(userCode)) throw new Error('The device code could not be read.')
    return {
      type: 'device_code',
      userCode,
      verificationUri: authorizationUrl(notice.verificationUri)
    }
  }
  if (notice.type === 'progress') return { type: 'progress', message: requiredText(notice.message) }
  throw new Error('The sign-in helper returned an unsupported notice.')
}

function parseCredential(providerId: string, value: unknown): JsonObject {
  const credential = jsonObject(value)
  if (!credential) throw new Error('The sign-in helper returned an invalid credential.')
  if (API_KEY_FLOW_PROVIDERS.has(providerId)) {
    if (credential.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key) {
      throw new Error('The sign-in helper returned an invalid API key.')
    }
    const result: JsonObject = { type: 'api_key', key: credential.key }
    const team = jsonObject(credential.primeTeam)
    if (providerId === 'prime-inference' && team) {
      if (typeof team.teamId !== 'string' || typeof team.name !== 'string') {
        throw new Error('The sign-in helper returned an invalid account selection.')
      }
      result.primeTeam = team
    }
    return result
  }
  if (
    credential.type !== 'oauth' ||
    typeof credential.access !== 'string' ||
    !credential.access ||
    typeof credential.expires !== 'number' ||
    !Number.isSafeInteger(credential.expires) ||
    credential.expires <= 0
  ) {
    throw new Error('The sign-in helper returned an invalid subscription credential.')
  }
  if (credential.refresh !== null && typeof credential.refresh !== 'string') {
    throw new Error('The sign-in helper returned an invalid refresh credential.')
  }
  const result: JsonObject = {
    type: 'oauth',
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires
  }
  for (const field of OPTIONAL_CREDENTIAL_FIELDS) {
    const value = credential[field]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw new Error('The sign-in credential could not be read.')
    result[field] = value
  }
  if (providerId === 'openai-codex' && !result.accountId) {
    throw new Error('The sign-in credential does not identify a ChatGPT account.')
  }
  if (providerId.startsWith('mcp:') && !result.endpoint) {
    throw new Error('The MCP credential does not identify its server.')
  }
  return result
}

class PrimeOAuthSession {
  readonly loginId = `prime-oauth-${randomUUID()}`
  private phase: LoginPhase = 'starting'
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly prompts = new Map<string, AuthFlowPrompt>()
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private receiveQueue = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private stopTimer: NodeJS.Timeout | undefined
  private mockStage = 0

  constructor(
    readonly providerId: string,
    private readonly method: AuthMethod,
    private readonly cwd: string | undefined,
    private readonly emit: EmitAuth,
    private readonly onChanged: () => void,
    private readonly remove: () => void
  ) {}

  async start(): Promise<void> {
    const mock = process.env.VENGEANCE_MOCK === '1' || process.env.VENGEANCE_MOCK === 'true'
    if (!mock) await shellEnvironmentReady()
    // Cancelled before it started.
    if (this.phase === 'done') return
    if (mock) {
      this.startMock()
      return
    }
    const executable = primeHelperPath()
    if (!existsSync(executable)) {
      this.finish(false, 'The Engine 2 sign-in component is missing. Reinstall Vengeance.')
      return
    }
    this.armTimeout(START_TIMEOUT_MS, 'The Engine 2 sign-in component did not start.')
    const child = spawn(executable, [], {
      cwd: dirname(executable),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...childBaseEnv(), DO_NOT_TRACK: '1' }
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.receiveData(chunk))
    child.stderr.resume()
    child.stdin.on('error', () => this.finish(false, 'The sign-in component stopped responding.'))
    child.on('error', () => this.finish(false, 'The Engine 2 sign-in component could not start.'))
    child.on('close', () => {
      clearTimeout(this.stopTimer)
      void this.receiveQueue.then(() => {
        if (this.phase !== 'done') this.finish(false, 'The sign-in component stopped unexpectedly.')
      })
    })
  }

  respond(promptId: string, value: string | null): boolean {
    const prompt = this.prompts.get(promptId)
    if (this.phase !== 'running' || !prompt) return false
    if (value === null) return this.cancel()
    if (Buffer.byteLength(value, 'utf8') > MAX_REPLY_BYTES) {
      this.finish(false, 'The sign-in response is too long.')
      return true
    }
    if (prompt.type === 'select' && !prompt.options.some((option) => option.id === value)) {
      this.finish(false, 'The selected account is no longer available.')
      return true
    }
    this.prompts.delete(promptId)
    if (this.child) this.send({ type: 'reply', promptId, value })
    else this.respondMock()
    return true
  }

  cancel(): boolean {
    // Once the atomic save starts, it completes as one account-store transaction.
    if (this.phase === 'saving' || this.phase === 'done') return false
    this.finish(false, undefined, true)
    return true
  }

  private event(event: AuthFlowEvent): void {
    this.emit({ ...event, engine: 'prime' })
  }

  private armTimeout(milliseconds: number, message: string): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.finish(false, message), milliseconds)
    this.timer.unref()
  }

  private send(message: JsonObject): void {
    if (!this.child?.stdin.writable) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receiveData(chunk: Buffer): void {
    if (this.phase === 'done') return
    this.buffer += this.decoder.write(chunk)
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      this.finish(false, 'The sign-in component returned too much data.')
      return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      this.receiveQueue = this.receiveQueue
        .then(() => this.receiveFrame(line))
        .catch(() => this.finish(false, 'The sign-in response could not be processed.'))
    }
  }

  private async receiveFrame(line: string): Promise<void> {
    if (this.phase === 'done') return
    const frame = jsonObject(JSON.parse(line) as unknown)
    if (!frame) throw new Error('Invalid sign-in frame')
    if (this.phase === 'starting') {
      this.receiveReady(frame)
      return
    }
    if (frame.type === 'notice') {
      const notice = parseNotice(frame.notice)
      this.event({ loginId: this.loginId, kind: 'notice', notice })
      const url =
        notice.type === 'auth_url'
          ? notice.url
          : notice.type === 'device_code'
            ? notice.verificationUri
            : undefined
      if (url) {
        void shell.openExternal(url).catch(() => {
          if (this.phase !== 'done') {
            this.event({
              loginId: this.loginId,
              kind: 'notice',
              notice: {
                type: 'info',
                message: 'Open the sign-in link in your browser to continue.'
              }
            })
          }
        })
      }
      return
    }
    if (frame.type === 'prompt') {
      const promptId = requiredText(frame.promptId)
      const prompt = parsePrompt(frame.prompt)
      this.prompts.set(promptId, prompt)
      this.event({ loginId: this.loginId, kind: 'prompt', promptId, prompt })
      return
    }
    if (frame.type === 'prompt_cancelled') {
      const promptId = requiredText(frame.promptId)
      if (this.prompts.delete(promptId)) {
        this.event({ loginId: this.loginId, kind: 'prompt-cancelled', promptId })
      }
      return
    }
    if (frame.type !== 'done') throw new Error('Unsupported sign-in frame')
    if (frame.ok !== true) {
      this.finish(
        false,
        frame.cancelled === true ? undefined : 'Sign-in could not be completed. Please try again.',
        frame.cancelled === true
      )
      return
    }
    const credential = parseCredential(this.providerId, frame.credential)
    this.phase = 'saving'
    clearTimeout(this.timer)
    try {
      await updatePrimeJson(join(getPrimeAgentDir(), 'auth.json'), (current) => {
        if (this.providerId === 'prime-inference') {
          const stored = jsonObject(current[this.providerId])
          if (frame.preservePrimeTeam === true && stored && stored.key === credential.key) {
            if (stored.primeTeam !== undefined) credential.primeTeam = stored.primeTeam
          } else if (credential.primeTeam === undefined) {
            credential.primeTeam = null
          }
        }
        return { ...current, [this.providerId]: credential }
      })
    } catch {
      this.finish(
        false,
        'Credentials could not be saved. Check access to the Engine 2 account folder.'
      )
      return
    }
    this.finish(true)
    this.onChanged()
  }

  private receiveReady(frame: JsonObject): void {
    if (
      frame.type !== 'ready' ||
      frame.protocol !== HELPER_PROTOCOL ||
      frame.revision !== HELPER_REVISION ||
      (this.providerId.startsWith('mcp:')
        ? frame.mcp !== true
        : !Array.isArray(frame.providers) || !frame.providers.includes(this.providerId))
    ) {
      throw new Error('The sign-in helper is incompatible')
    }
    this.phase = 'running'
    this.armTimeout(LOGIN_TIMEOUT_MS, 'Sign-in timed out. Start again when you are ready.')
    const agentDir = getPrimeAgentDir()
    const defaultAgentDir = join(homedir(), '.prime', 'agent')
    const primeCliConfigPath = samePath(agentDir, defaultAgentDir)
      ? join(homedir(), '.prime', 'config.json')
      : null
    this.send({
      type: 'start',
      providerId: this.providerId,
      method: this.method,
      primeCliConfigPath,
      cwd: this.cwd ?? agentDir,
      agentDir
    })
  }

  private finish(ok: boolean, error?: string, cancelled = false): void {
    if (this.phase === 'done') return
    this.phase = 'done'
    clearTimeout(this.timer)
    for (const promptId of this.prompts.keys()) {
      this.event({ loginId: this.loginId, kind: 'prompt-cancelled', promptId })
    }
    this.prompts.clear()
    this.buffer = ''
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.stdin.writable) {
        child.stdin.end(`${JSON.stringify({ type: 'cancel' })}\n`)
      }
      this.stopTimer = setTimeout(() => child.kill(), HELPER_STOP_TIMEOUT_MS)
      this.stopTimer.unref()
    }
    this.remove()
    this.event({ loginId: this.loginId, kind: 'done', ok, error, cancelled })
  }

  private mockPrompt(prompt: AuthFlowPrompt): void {
    const promptId = `mock-${this.mockStage++}`
    this.prompts.set(promptId, prompt)
    this.event({ loginId: this.loginId, kind: 'prompt', promptId, prompt })
  }

  private startMock(): void {
    this.phase = 'running'
    this.armTimeout(LOGIN_TIMEOUT_MS, 'Sign-in timed out. Start again when you are ready.')
    if (API_KEY_FLOW_PROVIDERS.has(this.providerId) && this.method === 'api_key') {
      this.mockPrompt({ type: 'secret', message: 'Enter your API key.' })
      return
    }
    const device = this.providerId === 'github-copilot' || this.providerId === 'xai'
    this.event({
      loginId: this.loginId,
      kind: 'notice',
      notice: device
        ? {
            type: 'device_code',
            userCode: 'VENG-2026',
            verificationUri: 'https://example.com/device'
          }
        : {
            type: 'auth_url',
            url: 'https://example.com/authorize',
            instructions: 'Complete sign-in in your browser.'
          }
    })
    this.mockPrompt({
      type: API_KEY_FLOW_PROVIDERS.has(this.providerId) ? 'secret' : 'manual_code',
      message: 'Complete sign-in in your browser, or enter a test response.'
    })
  }

  private respondMock(): void {
    if (this.providerId === 'prime-inference' && this.mockStage === 1) {
      this.mockPrompt({
        type: 'select',
        message: 'Choose the account for Prime Inference.',
        options: [
          { id: 'personal', label: 'Personal account' },
          { id: 'team:example', label: 'Example team', description: 'Member' }
        ]
      })
      return
    }
    this.finish(true)
    this.onChanged()
  }
}

const logins = new Map<string, PrimeOAuthSession>()

export async function startPrimeOAuth(
  args: StartLoginArgs,
  emit: EmitAuth,
  onChanged: () => void,
  options: LoginOptions = {}
): Promise<string> {
  const mcp = args.providerId.startsWith('mcp:') && args.providerId.length > 'mcp:'.length
  if (!mcp && !AUTH_FLOW_PROVIDERS.has(args.providerId)) {
    throw new Error('This Engine 2 provider does not support browser sign-in.')
  }
  for (const session of logins.values()) {
    if (session.providerId === args.providerId) session.cancel()
  }
  const session = new PrimeOAuthSession(
    args.providerId,
    args.method,
    options.cwd ?? args.cwd,
    emit,
    onChanged,
    () => logins.delete(session.loginId)
  )
  logins.set(session.loginId, session)
  setImmediate(() => void session.start())
  return session.loginId
}

export function respondPrimeOAuth(
  loginId: string,
  promptId: string,
  value: string | null
): boolean {
  return logins.get(loginId)?.respond(promptId, value) ?? false
}

export function cancelPrimeOAuth(loginId: string): boolean {
  return logins.get(loginId)?.cancel() ?? false
}

export function disposePrimeOAuth(): void {
  for (const session of logins.values()) session.cancel()
}
