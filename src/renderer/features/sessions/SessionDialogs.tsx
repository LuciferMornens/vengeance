import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  CircleStop,
  Copy,
  ExternalLink,
  FileInput,
  FolderInput,
  GitFork,
  Link2,
  MessageSquare,
  Search,
  Share2,
  Terminal,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type {
  ForkPoint,
  ImportCandidate,
  ShareReadiness,
  ShareSessionResult
} from '@shared/api/sessions'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import { basename, formatRelativeTime, pluralize } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { isModEnter } from '../../lib/keybindings'
import { lazyWithPreload } from '../../lib/lazy-with-preload'
import { samePath } from '../../lib/paths'
import { TRASH_NAME } from '../../lib/platform-copy'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { Button, Dialog, EmptyState, Input, ListRow, Skeleton, Spinner } from '../../ui'
import {
  closeAgent,
  deleteSession,
  forkAt,
  importAndOpen,
  pickImport,
  sessionTargetEngine
} from './actions'
import { matchesQuery } from './model'
import { useSessions, type SessionTarget } from './store'

const sessionTreeDialog = lazyWithPreload(() =>
  import('../inspector/SessionTreeDialog').then((m) => m.SessionTreeDialog)
)
const SessionTreeDialog = sessionTreeDialog.Component

/** Fork targets of a session: from the running engine when open, else read from the file. */
async function loadForkPoints(target: SessionTarget): Promise<ForkPoint[]> {
  if (target.agentId) {
    const { messages } = await rpc(target.agentId, { type: 'get_fork_messages' })
    const { entries } = await rpc(target.agentId, { type: 'get_entries' })
    const byId = new Map(entries.map((e) => [e.id, e]))
    return messages.map((m) => {
      const entry = byId.get(m.entryId)
      return {
        entryId: m.entryId,
        parentId: entry?.parentId ?? null,
        text: m.text,
        timestamp: entry ? new Date(entry.timestamp).getTime() : Date.now()
      }
    })
  }
  return target.path ? invoke('sessions:fork-points', target.path) : []
}

function ForkDialog({ target, onClose }: { target: SessionTarget; onClose: () => void }) {
  const [points, setPoints] = useState<ForkPoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const busy = useAgents((s) =>
    target.agentId ? s.agents[target.agentId]?.phase === 'running' : false
  )

  useEffect(() => {
    loadForkPoints(target)
      .then((list) => setPoints([...list].reverse()))
      .catch((e: Error) => setError(e.message))
  }, [target])

  const visible = points?.filter((p) => matchesQuery(query, p.text)) ?? []

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="picker"
      icon={<GitFork />}
      title="Fork from a message"
      description={
        busy
          ? 'The agent is working, so the fork opens as a new session next to this one.'
          : 'The fork ends right before the message you pick and puts it back in the composer to edit and resend.'
      }
    >
      {points && points.length > 6 && (
        <Input
          inputSize="sm"
          leading={<Search />}
          placeholder="Filter messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2"
        />
      )}
      <div className="-mx-2 flex max-h-[380px] flex-col gap-px overflow-y-auto pb-2">
        {!points && !error && [0, 1, 2].map((i) => <Skeleton key={i} className="mx-2 my-1 h-11" />)}
        {error && <div className="px-2 py-3 text-sm text-danger">{error}</div>}
        {points && points.length === 0 && (
          <EmptyState
            icon={<MessageSquare />}
            title="Nothing to fork yet"
            description="Send a message first. Forks start from one of your messages."
          />
        )}
        {visible.map((point, i) => (
          <ListRow
            key={point.entryId}
            density="rich"
            icon={<MessageSquare />}
            iconTile
            title={<span className="line-clamp-2 whitespace-normal">{point.text}</span>}
            subtitle={`${i === 0 && !query ? 'Latest message · ' : ''}${formatRelativeTime(point.timestamp)}`}
            onClick={() => {
              onClose()
              void forkAt(target, point)
            }}
          />
        ))}
      </div>
    </Dialog>
  )
}

// ─── Share ───────────────────────────────────────────────────────────────────

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex h-8 items-center gap-2 rounded-md bg-surface-1 pr-1 pl-2.5 shadow-elev-0">
      <Terminal className="size-3.5 shrink-0 text-fg-3" />
      <code className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg">
        {command}
      </code>
      <Button
        size="xs"
        variant="ghost"
        leading={copied ? <Check /> : <Copy />}
        onClick={() => {
          void navigator.clipboard.writeText(command)
          setCopied(true)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function ShareSetup({
  readiness,
  onRetry,
  checking
}: {
  readiness: Extract<ShareReadiness, { ready: false }>
  onRetry: () => void
  checking: boolean
}) {
  const missing = readiness.reason === 'missing-gh'
  if (readiness.reason === 'radius-signed-out') {
    return (
      <div className="flex flex-col gap-3 rounded-card bg-surface-1 p-3.5 shadow-elev-0">
        <p className="text-sm leading-relaxed text-fg-2">
          Sign in to Radius in Engine settings → Providers & Accounts, then check again.
        </p>
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" loading={checking} onClick={onRetry}>
            Check again
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 rounded-card bg-surface-1 p-3.5 shadow-elev-0">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="text-sm leading-relaxed text-fg-2">
          {missing ? (
            <>
              Sharing uploads the session as a secret gist with the GitHub CLI, which isn't
              installed yet.
            </>
          ) : (
            <>
              The GitHub CLI is installed but not signed in. Sign in once in a terminal, then check
              again.
            </>
          )}
        </div>
      </div>
      <ol className="flex flex-col gap-2.5 pl-[26px] text-sm text-fg-2">
        {missing && (
          <li className="flex items-center justify-between gap-3">
            <span>
              <span className="tabular mr-1.5 text-fg-3">1.</span>Install the GitHub CLI
            </span>
            <Button
              size="xs"
              variant="secondary"
              trailing={<ExternalLink />}
              onClick={() => void invoke('sys:open-external', 'https://cli.github.com/')}
            >
              cli.github.com
            </Button>
          </li>
        )}
        <li className="flex flex-col gap-1.5">
          <span>
            <span className="tabular mr-1.5 text-fg-3">{missing ? '2.' : '1.'}</span>Sign in to
            GitHub
          </span>
          <CommandLine command="gh auth login" />
        </li>
      </ol>
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" loading={checking} onClick={onRetry}>
          Check again
        </Button>
      </div>
    </div>
  )
}

function ShareResult({
  result,
  initiallyCopied
}: {
  result: ShareSessionResult
  initiallyCopied: boolean
}) {
  const [copied, setCopied] = useState(initiallyCopied)
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-9 items-center gap-2 rounded-md bg-surface-1 pr-1 pl-3 shadow-elev-0">
        <Link2 className="size-3.5 shrink-0 text-fg-3" />
        <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg">
          {result.url}
        </span>
        <Button
          size="xs"
          variant="ghost"
          leading={copied ? <Check className="text-success" /> : <Copy />}
          onClick={async () => {
            await navigator.clipboard
              .writeText(result.url)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {result.destination === 'gist' && (
        <button
          type="button"
          onClick={() => void invoke('sys:open-external', result.gistUrl)}
          className="flex items-center gap-1.5 self-start rounded-xs text-xs text-fg-3 hover:text-fg-2"
        >
          Gist <span className="font-mono">{result.gistUrl.replace(/^https:\/\//, '')}</span>
          <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  )
}

function ShareDialog({ target, onClose }: { target: SessionTarget; onClose: () => void }) {
  const [readiness, setReadiness] = useState<ShareReadiness | null>(null)
  const [checking, setChecking] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [result, setResult] = useState<ShareSessionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const checkRequest = useRef(0)
  const engine = sessionTargetEngine(target)

  const check = useCallback(() => {
    const request = ++checkRequest.current
    setChecking(true)
    setReadiness(null)
    setError(null)
    invoke('sessions:share-readiness', {
      engine,
      sessionPath: target.path ?? '',
      agentId: target.agentId
    })
      .then((value) => {
        if (request === checkRequest.current) setReadiness(value)
      })
      .catch((failure: Error) => {
        if (request === checkRequest.current) setError(failure.message)
      })
      .finally(() => {
        if (request === checkRequest.current) setChecking(false)
      })
  }, [engine, target.path, target.agentId])
  useEffect(() => {
    check()
    return () => {
      checkRequest.current++
    }
  }, [check])

  const share = async () => {
    setSharing(true)
    setError(null)
    try {
      const shared = await invoke('sessions:share', {
        engine,
        sessionPath: target.path ?? '',
        agentId: target.agentId,
        title: target.title,
        destination: readiness?.destination
      })
      const copied = await navigator.clipboard
        .writeText(shared.url)
        .then(() => true)
        .catch(() => false)
      setCopied(copied)
      setResult(shared)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSharing(false)
    }
  }

  const ready = readiness?.ready === true
  const destination = result?.destination ?? readiness?.destination
  const description =
    destination === 'radius'
      ? result
        ? 'Shared with your Radius organization.'
        : 'Uploads this session to your Radius organization and copies its link.'
      : destination === 'gist'
        ? result
          ? 'Anyone with the link can view the session. Delete the gist on GitHub to take it down.'
          : 'Creates a secret GitHub gist with a web page of this session and copies its link.'
        : 'Checking the sharing destination for this session.'
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !sharing && onClose()}
      persistent={sharing}
      size="form"
      icon={result ? <Check /> : <Share2 />}
      iconTone={result ? 'success' : 'neutral'}
      title={result ? (copied ? 'Link copied' : 'Session shared') : 'Share this session'}
      description={description}
      footer={
        result ? (
          <>
            <Button
              variant="secondary"
              leading={<ExternalLink />}
              onClick={() => void invoke('sys:open-external', result.url)}
            >
              Open link
            </Button>
            <Button variant="primary" data-autofocus onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={sharing}>
              Cancel
            </Button>
            <Button
              variant="primary"
              leading={<Link2 />}
              loading={sharing}
              disabled={!ready}
              onClick={() => void share()}
            >
              {sharing ? 'Uploading…' : 'Create link'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ShareResult result={result} initiallyCopied={copied} />
      ) : (
        <div className="flex flex-col gap-3 pb-1">
          <div className="rounded-card bg-surface-1 px-3.5 py-3 shadow-elev-0">
            <div className="mb-2 text-xs font-medium text-fg-3">
              Review before sharing. The page includes
            </div>
            <ul className="flex flex-col gap-1.5 text-sm text-fg-2">
              {[
                'Every message on the current branch',
                'Tool calls with their output, including file contents',
                'Command output and extension messages',
                ...(destination === 'radius' ? ['System instructions and tool definitions'] : [])
              ].map((line) => (
                <li key={line} className="flex items-center gap-2">
                  <span className="size-1 shrink-0 rounded-full bg-fg-3" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
          {readiness && !readiness.ready && (
            <ShareSetup readiness={readiness} onRetry={check} checking={checking} />
          )}
          {!readiness && !error && (
            <div className="flex items-center gap-2 px-1 text-xs text-fg-3">
              <Spinner size={11} /> Checking sharing destination…
            </div>
          )}
          {error && (
            <div className="flex flex-col gap-2">
              <p
                role="alert"
                className="selectable rounded-md bg-danger-soft px-3 py-2 text-sm text-danger shadow-[inset_0_0_0_1px_var(--danger-border)]"
              >
                {error}
              </p>
              <Button size="sm" variant="secondary" loading={checking} onClick={check}>
                Check destination again
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

// ─── Import ──────────────────────────────────────────────────────────────────

function ImportDialog({ candidate, onClose }: { candidate: ImportCandidate; onClose: () => void }) {
  const workspace = useApp((s) => s.prefs.activeWorkspace)
  const [targetWorkspace, setTargetWorkspace] = useState(
    workspace && !samePath(workspace, candidate.cwd) ? workspace : null
  )
  const [busy, setBusy] = useState(false)
  const continuesIn = candidate.cwdExists ? candidate.cwd : targetWorkspace
  const title = candidate.name || candidate.firstMessage || 'Untitled session'

  const run = async () => {
    if (!continuesIn || busy) return
    setBusy(true)
    const ok = await importAndOpen(candidate, continuesIn)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      persistent={busy}
      size="form"
      icon={<FileInput />}
      title="Import a session"
      description="The file is copied into your session history and opened. The original is never changed."
      hint={{ combo: 'mod+enter', label: 'to import' }}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              onClose()
              void pickImport(candidate.engine)
            }}
          >
            Choose another…
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!continuesIn}
            data-autofocus
            onClick={() => void run()}
          >
            Import and open
          </Button>
        </>
      }
    >
      <div
        className="flex flex-col gap-3 pb-1"
        onKeyDown={(e) => {
          if (isModEnter(e)) void run()
        }}
      >
        <div className="flex items-start gap-3 rounded-card bg-surface-1 px-3.5 py-3 shadow-elev-0">
          <MessageSquare className="mt-0.5 size-4 shrink-0 text-fg-3" />
          <div className="min-w-0 flex-1">
            <div className="weight-row line-clamp-2 text-ui text-fg">{title}</div>
            <div className="mt-0.5 text-xs text-fg-3">
              <span className="tabular">{pluralize(candidate.messageCount, 'message')}</span> ·
              started {formatRelativeTime(candidate.createdAt)}
            </div>
            <div
              className="mt-1.5 truncate font-mono text-2xs text-fg-3"
              title={candidate.sourcePath}
            >
              {candidate.fileName}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 px-0.5">
          <div className="text-xs font-medium text-fg-3">Continues in</div>
          <div className="flex items-center gap-2 text-sm text-fg">
            <FolderInput className="size-4 shrink-0 text-fg-3" />
            <span className="truncate">
              {continuesIn ? basename(continuesIn) : 'No workspace open'}
            </span>
            {continuesIn && (
              <span className="min-w-0 truncate font-mono text-2xs text-fg-3">{continuesIn}</span>
            )}
          </div>
          {!candidate.cwdExists && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void invoke('sys:pick-folder', undefined).then((folder) => {
                  if (folder) setTargetWorkspace(folder)
                })
              }}
            >
              Choose workspace…
            </Button>
          )}
          {!candidate.cwdExists && (
            <div
              className={cn(
                'mt-1 flex items-start gap-2 rounded-md bg-warning-soft px-2.5 py-2 text-xs leading-relaxed text-fg-2 shadow-[inset_0_0_0_1px_var(--warning-border)]'
              )}
            >
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
              <span>
                Its original folder{' '}
                <span className="font-mono text-fg">{candidate.cwd || 'unknown'}</span> doesn't
                exist on this computer, so the copy continues in{' '}
                {continuesIn ? 'this workspace' : 'a workspace you choose'}.
              </span>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  )
}

function DeleteDialog({
  target,
  onClose
}: {
  target: SessionTarget & { path: string }
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stopsResident = sessionTargetEngine(target) === 'prime'

  async function remove(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteSession(target)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      persistent={busy}
      size="confirm"
      icon={<Trash2 />}
      iconTone="danger"
      title="Delete this session?"
      description={
        <>
          <span className="font-medium text-fg">“{target.title}”</span> moves to the {TRASH_NAME}.
          {stopsResident && ' Its running work and schedules will stop.'} To recover the
          conversation, restore its file from the {TRASH_NAME} and import it as a new session.
        </>
      }
      footer={
        <>
          <Button variant="ghost" data-autofocus disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {error ? 'Try again' : `Move to ${TRASH_NAME}`}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-sm text-danger">
          Could not delete the session. {error}
        </p>
      )}
    </Dialog>
  )
}

/** Fork / delete / close-while-running / share / import / closed-session tree dialogs driven by the sessions store. */
export function SessionDialogs() {
  const dialog = useSessions((s) => s.dialog)
  const openDialog = useSessions((s) => s.openDialog)
  const close = () => openDialog(null)
  const treeLoaded = sessionTreeDialog.useLoaded(dialog?.kind === 'tree')

  if (!dialog) return null
  switch (dialog.kind) {
    case 'fork':
      return <ForkDialog target={dialog.target} onClose={close} />
    case 'share':
      return <ShareDialog target={dialog.target} onClose={close} />
    case 'import':
      return (
        <ImportDialog
          key={dialog.candidate.sourcePath}
          candidate={dialog.candidate}
          onClose={close}
        />
      )
    case 'tree':
      return treeLoaded ? (
        <Suspense fallback={null}>
          <SessionTreeDialog target={dialog.target} onClose={close} />
        </Suspense>
      ) : null
    case 'delete':
      return <DeleteDialog key={dialog.target.path} target={dialog.target} onClose={close} />
    case 'close':
      return (
        <Dialog
          open
          onOpenChange={(open) => !open && close()}
          size="confirm"
          icon={<CircleStop />}
          iconTone="warning"
          title="Stop and close this session?"
          description={
            <>
              <span className="font-medium text-fg">“{dialog.title}”</span> is still working.
              Closing stops the engine; everything so far stays saved in your history.
            </>
          }
          footer={
            <>
              <Button variant="ghost" onClick={close}>
                Keep running
              </Button>
              <Button
                variant="danger"
                data-autofocus
                onClick={() => {
                  close()
                  void closeAgent(dialog.agentId)
                }}
              >
                Stop and close
              </Button>
            </>
          }
        />
      )
  }
}
