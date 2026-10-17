import { spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type {
  PrimeTracePreview,
  PrimeTracesArgs,
  PrimeTracesProgress,
  PrimeTracesResult,
  PrimeTracesStatus
} from '@shared/api/traces'
import { env } from '../../env'
import { childBaseEnv, shellEnvironmentReady } from '../../shell-env'
import { primeHelperPath } from './helper'
import { getPrimeAgentDir } from './locate'
import { asRecord } from './transport'

const MAX_FRAME_BYTES = 128 * 1024
const READ_TIMEOUT_MS = 60_000
const MAX_PREVIEW_LINES = 100
const MAX_REDACTION_DEPTH = 32
const REDACTED = '[redacted]'
const CREDENTIAL_FIELDS = new RegExp(
  '(?:apikey|accesstoken|refreshtoken|idtoken|clientsecret|password|passwd|' +
    'authorization|cookie|privatekey|secret|token)$',
  'i'
)
const CREDENTIAL_CONTAINERS = new Set([
  'auth',
  'authentication',
  'credentials',
  'secrets',
  'headers',
  'httpheaders',
  'requestheaders',
  'responseheaders'
])
const CREDENTIAL_TYPES = new Set(['api_key', 'oauth', 'mcp_static_token'])
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`((?:\b[\w-]*(?:api[_-]?key|token|secret|password)\b|` +
    String.raw`authorization|cookie|set-cookie)\s*["']?\s*[:=]\s*)` +
    String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}\]]+)`,
  'gi'
)
const RESULT_STATUSES = new Set<PrimeTracesStatus>([
  'ready',
  'uploaded',
  'disabled',
  'unchanged',
  'missing_credentials',
  'no_session_file',
  'empty_session',
  'invalid_session',
  'too_large',
  'failed',
  'cancelled'
])
const ENTRY_TYPES = new Set([
  'session',
  'message',
  'model_change',
  'thinking_level_change',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
  'service_tier_change'
])
const CONTENT_TYPES = new Set(['text', 'thinking', 'image', 'toolCall', 'toolResult'])
const MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult', 'system'])
const uploads = new Map<string, { child: ChildProcess; cancelled: boolean }>()
const operations = new Set<{ child: ChildProcess; cancelled: boolean }>()
let mockEnabled = false

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

// The summary stays structural until the user explicitly requests the native content preview.
function contentPreview(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .split('\n')
    .slice(0, MAX_PREVIEW_LINES)
    .filter(Boolean)
    .map((line) => {
      try {
        const entry = asRecord(JSON.parse(line))
        const entryType = text(entry.type)
        const message = asRecord(entry.message)
        const role = text(message.role)
        const content = Array.isArray(message.content) ? message.content : []
        return JSON.stringify({
          type: entryType && ENTRY_TYPES.has(entryType) ? entryType : 'custom',
          ...(role && MESSAGE_ROLES.has(role) ? { role } : {}),
          ...(content.length
            ? {
                contentBlocks: content.map((block) => {
                  const blockType = text(asRecord(block).type)
                  return blockType && CONTENT_TYPES.has(blockType) ? blockType : 'custom'
                })
              }
            : {}),
          content: '[hidden in preview]'
        })
      } catch {
        return '[Partial trace entry omitted]'
      }
    })
    .join('\n')
}

function redactText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      REDACTED
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(CREDENTIAL_ASSIGNMENT, `$1${REDACTED}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, REDACTED)
}

function redactTraceValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_REDACTION_DEPTH) return '[Nested content omitted]'
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(redactTraceValue(JSON.parse(trimmed), depth + 1))
      } catch {
        return redactText(value)
      }
    }
    return redactText(value)
  }
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const record = asRecord(value)
  if (CREDENTIAL_TYPES.has(text(record.type) ?? '')) return REDACTED
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      const normalized = key.replace(/[-_\s]/g, '')
      const sensitive =
        CREDENTIAL_FIELDS.test(normalized) || CREDENTIAL_CONTAINERS.has(normalized.toLowerCase())
      return [key, sensitive ? REDACTED : redactTraceValue(entry, depth + 1)]
    })
  )
}

function fullContentPreview(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      try {
        return JSON.stringify(redactTraceValue(JSON.parse(line)), null, 2)
      } catch {
        // Native previews may begin or end inside a JSONL entry when the trace is truncated.
        return redactText(line)
      }
    })
    .join('\n')
}

function preview(value: unknown, revealContent: boolean): PrimeTracePreview | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = asRecord(value)
  const sessionFile = text(data.sessionFile)
  const sessionId = text(data.sessionId)
  const traceId = text(data.traceId)
  if (!sessionFile || !sessionId || !traceId) return undefined
  return {
    sessionFile,
    sessionId,
    traceId,
    parentSessionId: text(data.parentSessionId),
    size: number(data.size) ?? 0,
    maxBytes: number(data.maxBytes) ?? 0,
    uploadable: data.uploadable === true,
    endpoint: safeUrl(data.endpoint) ?? '',
    gitRepo: safeUrl(data.gitRepo),
    gitCommit: text(data.gitCommit),
    contentPreview: revealContent
      ? fullContentPreview(data.contentPreview)
      : contentPreview(data.contentPreview),
    truncated: data.truncated === true
  }
}

function result(args: PrimeTracesArgs, value: unknown): PrimeTracesResult {
  const data = asRecord(value)
  const status = text(data.status) as PrimeTracesStatus | undefined
  if (!status || !RESULT_STATUSES.has(status)) throw new Error('Invalid Engine trace response.')
  return {
    action: args.action,
    status,
    enabled: typeof data.enabled === 'boolean' ? data.enabled : undefined,
    credentialLabel: data.credentialLabel === null ? null : text(data.credentialLabel),
    logPath: text(data.logPath),
    preview: preview(data.preview, args.action === 'preview-content'),
    uploaded: number(data.uploaded),
    failed: number(data.failed),
    skipped: number(data.skipped),
    total: number(data.total),
    bytesStored: number(data.bytesStored),
    size: number(data.size),
    maxBytes: number(data.maxBytes),
    statusCode: number(data.statusCode),
    message: text(data.message)
  }
}

function mockResult(args: PrimeTracesArgs, sessionFile?: string): PrimeTracesResult {
  if (args.action === 'on') mockEnabled = true
  if (args.action === 'off') mockEnabled = false
  if (args.action === 'status' || args.action === 'on' || args.action === 'off') {
    return {
      action: args.action,
      status: 'ready',
      enabled: mockEnabled,
      credentialLabel: 'Mock trace account',
      logPath: join(getPrimeAgentDir(), 'logs', 'agent-traces.log')
    }
  }
  if (args.action === 'preview' || args.action === 'preview-content') {
    const nativePreview = JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'The workspace checks passed. The session is ready to review.' }
        ],
        headers: { Authorization: 'Bearer mock-private-key' }
      }
    })
    return {
      action: args.action,
      status: 'ready',
      preview: {
        sessionFile: sessionFile ?? join(getPrimeAgentDir(), 'sessions', 'mock-session.jsonl'),
        sessionId: 'mock-session',
        traceId: 'mock-session',
        size: 2048,
        maxBytes: 20 * 1024 * 1024,
        uploadable: true,
        endpoint: 'https://api.primeintellect.ai/api/v1/agent-traces/sessions/mock-session',
        contentPreview:
          args.action === 'preview-content'
            ? fullContentPreview(nativePreview)
            : contentPreview(nativePreview),
        truncated: false
      }
    }
  }
  return { action: args.action, status: 'uploaded', total: 1, uploaded: 1, failed: 0, skipped: 0 }
}

export function cancelPrimeTraces(cwd: string): void {
  const upload = uploads.get(resolve(cwd))
  if (!upload) return
  upload.cancelled = true
  upload.child.kill()
}

export function cancelAllPrimeTraces(): void {
  for (const operation of operations) {
    operation.cancelled = true
    operation.child.kill()
  }
}

export async function runPrimeTraces(
  args: PrimeTracesArgs,
  sessionFile?: string,
  sessionDir?: string,
  onProgress?: (progress: PrimeTracesProgress) => void
): Promise<PrimeTracesResult> {
  if (env.mock) return mockResult(args, sessionFile)
  await shellEnvironmentReady()
  const cwd = resolve(args.cwd)
  const upload =
    args.action === 'on' ||
    args.action === 'upload' ||
    args.action === 'upload-current' ||
    args.action === 'upload-all'
  if (upload && uploads.has(cwd))
    throw new Error('A trace upload is already running in this workspace.')
  return new Promise((resolveResult, reject) => {
    const child = spawn(primeHelperPath(), ['--traces'], {
      cwd,
      windowsHide: true,
      env: { ...childBaseEnv(), PRIME_AGENT_CODING_AGENT_DIR: getPrimeAgentDir() },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const operation = { child, cancelled: false }
    operations.add(operation)
    if (upload) uploads.set(cwd, operation)
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let response: PrimeTracesResult | undefined
    let failure: Error | undefined
    let settled = false
    const timeout = upload
      ? undefined
      : setTimeout(() => {
          failure = new Error('The Engine trace action timed out.')
          child.kill()
        }, READ_TIMEOUT_MS)
    timeout?.unref()
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      operations.delete(operation)
      if (uploads.get(cwd) === operation) uploads.delete(cwd)
      if (operation.cancelled) {
        resolveResult({ action: args.action, status: 'cancelled' })
      } else if (failure) reject(failure)
      else if (response) resolveResult(response)
      else reject(new Error('The Engine trace action did not return a result.'))
    }
    child.once('error', () => {
      failure = new Error('The native Engine trace helper could not start.')
      finish()
    })
    child.stdin.on('error', () => {
      failure ??= new Error('The native Engine trace request could not be sent.')
      child.kill()
    })
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const frame = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error()
          const event = asRecord(JSON.parse(frame))
          if (event.type === 'progress') {
            const completed = number(event.completed)
            const total = number(event.total)
            if (completed !== undefined && total !== undefined)
              onProgress?.({ cwd, completed, total })
          } else if (event.ok === true) response = result(args, event.result)
          else failure = new Error('The Engine trace action could not complete.')
        } catch {
          failure = new Error('The Engine trace helper returned an invalid response.')
          child.kill()
          return
        }
        newline = buffer.indexOf('\n')
      }
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        failure = new Error('The Engine trace response exceeded its size limit.')
        child.kill()
      }
    })
    child.once('close', (code) => {
      if (code !== 0 && !operation.cancelled)
        failure ??= new Error('The Engine trace action failed.')
      finish()
    })
    child.stdin.end(
      JSON.stringify({
        action: args.action,
        cwd,
        agentDir: getPrimeAgentDir(),
        sessionFile,
        sessionDir
      })
    )
  })
}
