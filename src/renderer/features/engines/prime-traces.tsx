import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Eye, FolderOpen, RefreshCw, Upload } from 'lucide-react'
import type {
  PrimeTracePreview,
  PrimeTracesAction,
  PrimeTracesProgress,
  PrimeTracesResult
} from '@shared/api/traces'
import { invoke, on } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { Badge, Button, Checkbox, IconButton } from '../../ui'
import { LoginDialog, useLoginFlow } from '../settings/auth-flow'
import { errorText, PrimeFeedback } from './prime-runtime'
import { PRIME_TRACE_ACTIONS } from './prime-schema'

const TRACE_PROVIDER = { id: 'prime-agent-traces', name: 'Trace uploads' }
const MAX_PREVIEW_ROWS = 80
const BYTES_PER_KILOBYTE = 1024

interface PreviewRow {
  kind: string
  role?: string
  blocks: string[]
}

function previewRows(content: string): PreviewRow[] {
  const rows: PreviewRow[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const entry = value as Record<string, unknown>
      if (typeof entry.type !== 'string') continue
      rows.push({
        kind: entry.type,
        role: typeof entry.role === 'string' ? entry.role : undefined,
        blocks: Array.isArray(entry.contentBlocks)
          ? entry.contentBlocks.filter((block): block is string => typeof block === 'string')
          : []
      })
    } catch {
      // Native previews can end with a deliberately omitted partial trace entry.
    }
  }
  return rows
}

function formatBytes(bytes: number): string {
  return `${(bytes / BYTES_PER_KILOBYTE).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
}

function traceNotice(result: PrimeTracesResult): string {
  switch (result.status) {
    case 'ready':
      return result.action === 'preview' || result.action === 'preview-content'
        ? 'Trace preview ready.'
        : ''
    case 'uploaded': {
      const uploaded = result.uploaded ?? 1
      return `${uploaded} trace${uploaded === 1 ? '' : 's'} uploaded. ${result.skipped ?? 0} skipped; ${result.failed ?? 0} failed.`
    }
    case 'unchanged':
      return 'This trace has already been uploaded and has no new content.'
    case 'missing_credentials':
      return 'Sign in for trace uploads, then try the upload again.'
    case 'disabled':
      return 'Trace sharing is off. Turn it on before uploading.'
    case 'no_session_file':
      return 'This session has no saved file to preview or upload yet.'
    case 'empty_session':
      return 'This session has no trace content yet.'
    case 'invalid_session':
      return 'The engine could not read this session as a trace.'
    case 'too_large':
      return `This trace exceeds the upload limit${result.maxBytes ? ` of ${formatBytes(result.maxBytes)}` : ''}.`
    case 'cancelled':
      return 'Trace upload cancelled.'
    case 'failed':
      return result.message || 'The upload failed. Review the trace log and try again.'
  }
}

const TracePreview = memo(function TracePreview({ preview }: { preview: PrimeTracePreview }) {
  const rows = previewRows(preview.contentPreview)
  const visibleRows = rows.slice(0, MAX_PREVIEW_ROWS)
  return (
    <section className="space-y-3 border-t border-hairline-soft pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-fg">Current session preview</h3>
        <Badge>{preview.uploadable ? 'Within upload limit' : 'Too large to upload'}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-xs">
        <dt className="text-fg-3">Session</dt>
        <dd className="break-all text-fg-2">{preview.sessionId}</dd>
        <dt className="text-fg-3">Trace</dt>
        <dd className="break-all text-fg-2">{preview.traceId}</dd>
        <dt className="text-fg-3">Size</dt>
        <dd className="tabular-nums text-fg-2">
          {formatBytes(preview.size)} / {formatBytes(preview.maxBytes)}
        </dd>
        <dt className="text-fg-3">Destination</dt>
        <dd className="break-all text-fg-2">{preview.endpoint}</dd>
        {preview.gitRepo && (
          <>
            <dt className="text-fg-3">Repository</dt>
            <dd className="break-all text-fg-2">{preview.gitRepo}</dd>
          </>
        )}
        {preview.gitCommit && (
          <>
            <dt className="text-fg-3">Commit</dt>
            <dd className="break-all text-fg-2">{preview.gitCommit}</dd>
          </>
        )}
      </dl>
      {visibleRows.length > 0 && (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-fg-3">
              <tr className="border-b border-hairline-soft">
                <th className="py-2 font-medium">Entry</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="py-2 font-medium">Content types</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, index) => (
                <tr key={index} className="border-b border-hairline-soft align-top text-fg-2">
                  <td className="py-2">{row.kind}</td>
                  <td className="px-3 py-2">{row.role || '—'}</td>
                  <td className="py-2">{row.blocks.join(', ') || 'Metadata'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(preview.truncated || rows.length > MAX_PREVIEW_ROWS) && (
        <p className="text-xs text-fg-3">
          Showing the first {visibleRows.length} complete entries.
        </p>
      )}
      {!visibleRows.length && (
        <p className="text-xs text-fg-3">No complete entries in this preview.</p>
      )}
    </section>
  )
})

export function PrimeTraces({
  agentId,
  initialAction = '',
  onInitialActionConsumed
}: {
  agentId: string
  initialAction?: string
  onInitialActionConsumed(): void
}) {
  const cwd = useAgents((state) => state.agents[agentId]?.info.cwd)
  const [status, setStatus] = useState<PrimeTracesResult | null>(null)
  const [preview, setPreview] = useState<PrimeTracePreview | null>(null)
  const [contentPreview, setContentPreview] = useState<PrimeTracePreview | null>(null)
  const [outcome, setOutcome] = useState<PrimeTracesResult | null>(null)
  const [pending, setPending] = useState<PrimeTracesAction | null>(null)
  const [progress, setProgress] = useState<PrimeTracesProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resumeAfterLogin, setResumeAfterLogin] = useState<PrimeTracesAction | null>(null)
  const mounted = useRef(false)
  const requestPending = useRef(false)
  const initialConsumed = useRef(false)
  const loginAction = useRef<PrimeTracesAction | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadStatus = useCallback(async () => {
    if (!cwd) return
    const result = await invoke('engine:traces', { agentId, cwd, action: 'status' })
    if (mounted.current) setStatus(result)
  }, [agentId, cwd])

  const login = useLoginFlow((success) => {
    if (!success) return
    if (loginAction.current) {
      setResumeAfterLogin(loginAction.current)
      loginAction.current = null
    } else {
      void loadStatus().catch((failure) => {
        if (mounted.current) setError(errorText(failure))
      })
    }
  })
  const startLogin = useCallback(
    (afterLogin?: PrimeTracesAction) => {
      loginAction.current = afterLogin ?? null
      if (cwd) void login.start(TRACE_PROVIDER, 'oauth', { engine: 'prime', cwd })
    },
    [cwd, login.start]
  )

  const perform = useCallback(
    async (action: PrimeTracesAction) => {
      if (!cwd || requestPending.current) return
      requestPending.current = true
      setPending(action)
      setError(null)
      setOutcome(null)
      setProgress(null)
      try {
        const result = await invoke('engine:traces', { agentId, cwd, action })
        if (!mounted.current) return
        if (action === 'status' || action === 'on' || action === 'off') setStatus(result)
        if (result.preview) {
          if (action === 'preview-content') setContentPreview(result.preview)
          else setPreview(result.preview)
        }
        setOutcome(result)
        if (action === 'on' && result.status === 'missing_credentials') startLogin('on')
        if (action !== 'status') await loadStatus()
      } catch (failure) {
        if (mounted.current) setError(errorText(failure))
      } finally {
        requestPending.current = false
        if (mounted.current) setPending(null)
      }
    },
    [agentId, cwd, loadStatus, startLogin]
  )

  useEffect(() => {
    if (!resumeAfterLogin || pending) return
    setResumeAfterLogin(null)
    void perform(resumeAfterLogin)
  }, [pending, perform, resumeAfterLogin])

  useEffect(
    () =>
      on('engine:traces-progress', (event) => {
        if (event.cwd === cwd) setProgress(event)
      }),
    [cwd]
  )

  useEffect(() => {
    if (!cwd || initialConsumed.current) return
    initialConsumed.current = true
    onInitialActionConsumed()
    if (initialAction === 'login') {
      startLogin()
      void perform('status')
    } else {
      const action =
        PRIME_TRACE_ACTIONS.includes(initialAction) && initialAction !== 'login'
          ? (initialAction as PrimeTracesAction)
          : 'status'
      void perform(action)
    }
  }, [cwd, initialAction, onInitialActionConsumed, perform, startLogin])

  const uploading =
    pending === 'on' ||
    pending === 'upload' ||
    pending === 'upload-current' ||
    pending === 'upload-all'
  const notice = outcome ? traceNotice(outcome) : undefined
  const cancelUpload = async () => {
    if (!cwd) return
    try {
      await invoke('engine:traces-cancel', cwd)
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  return (
    <div className="space-y-5 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Preview and upload native session traces for diagnostics. Preview hides message text and
        tool data. Upload shares the complete session trace.
      </p>
      <PrimeFeedback error={error} notice={notice || undefined} />
      <div className="flex items-center justify-between gap-4">
        <label className="flex flex-1 items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-fg">Share session traces</span>
            <span className="mt-1 block text-xs text-fg-3">
              {status?.enabled === undefined
                ? 'Loading native preference…'
                : status.enabled
                  ? 'Enabled in the engine'
                  : 'Off'}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-fg-3">
              Enabling uploads this session and allows the engine to share future traces.
            </span>
          </span>
          <Checkbox
            checked={status?.enabled === true}
            disabled={!!pending || !status}
            onCheckedChange={(enabled) => void perform(enabled ? 'on' : 'off')}
          />
        </label>
        <IconButton
          label="Refresh trace status"
          disabled={!!pending}
          onClick={() => void perform('status')}
        >
          <RefreshCw />
        </IconButton>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline-soft pt-4">
        <div>
          <h3 className="text-sm font-medium text-fg">Upload account</h3>
          <p className="mt-1 text-xs text-fg-3">
            {status?.credentialLabel || 'Sign in to upload traces.'}
          </p>
        </div>
        <Button size="sm" disabled={!!pending} onClick={() => startLogin()}>
          {status?.credentialLabel ? 'Sign in again' : 'Sign in'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button leading={<Eye />} disabled={!!pending} onClick={() => void perform('preview')}>
          Preview current session
        </Button>
        <Button
          disabled={!!pending}
          onClick={() =>
            contentPreview ? setContentPreview(null) : void perform('preview-content')
          }
        >
          {contentPreview ? 'Hide trace content' : 'Show trace content'}
        </Button>
        <Button
          leading={<Upload />}
          disabled={!!pending}
          onClick={() => void perform('upload-current')}
        >
          Upload current session
        </Button>
        <Button disabled={!!pending} onClick={() => void perform('upload-all')}>
          Upload all sessions
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-fg-3">
        Upload all includes eligible stored sessions, including sessions in other workspaces.
        Already uploaded content is skipped by the engine.
      </p>
      {pending && (
        <div className="flex items-center justify-between gap-3 text-sm text-fg-3" role="status">
          <span>
            {uploading
              ? progress
                ? `Uploading traces: ${progress.completed} of ${progress.total} processed…`
                : 'Uploading trace…'
              : 'Reading trace information…'}
          </span>
          {uploading && (
            <Button size="sm" variant="ghost" onClick={() => void cancelUpload()}>
              Cancel upload
            </Button>
          )}
        </div>
      )}
      {status?.logPath && (
        <Button
          size="sm"
          variant="ghost"
          leading={<FolderOpen />}
          onClick={() =>
            void invoke('sys:reveal', status.logPath!).catch((failure) =>
              setError(errorText(failure))
            )
          }
        >
          Reveal trace log
        </Button>
      )}
      {preview && <TracePreview preview={preview} />}
      {contentPreview && (
        <section className="space-y-3 border-t border-hairline-soft pt-5">
          <h3 className="text-sm font-medium text-fg">Trace content</h3>
          <p className="text-xs leading-relaxed text-fg-3">
            Known credential fields are redacted; review carefully. Upload sends the complete
            original trace.
            {contentPreview.truncated &&
              ' This preview is truncated to the engine’s display limit.'}
          </p>
          <pre
            tabIndex={0}
            aria-label="Trace content preview"
            className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-1 p-3 font-mono text-xs leading-relaxed text-fg-2"
          >
            {contentPreview.contentPreview}
          </pre>
        </section>
      )}
      <LoginDialog flow={login} />
    </div>
  )
}
