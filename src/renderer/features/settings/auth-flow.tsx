import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  ShieldCheck,
  XCircle
} from 'lucide-react'
import type {
  AuthFlowEvent,
  AuthFlowNotice,
  AuthFlowPrompt,
  AuthMethod,
  ProviderInfo
} from '@shared/api/settings'
import type { EngineId } from '@shared/api/engine'
import { cn } from '../../lib/cn'
import { invoke, on, settingsInvokeForFolder } from './ipc'
import { Button, Dialog, Input, Spinner, toast } from '../../ui'
import { FOCUS_RING } from './controls'
import { providerName } from './provider-name'
import { activeCwd, useSettings } from './store'

/**
 * Provider sign-in through the engine's own auth flows (pi-ai). Main opens the browser for OAuth;
 * the renderer shows notices and answers prompts. Secrets typed here go straight back to main.
 */

export interface LoginState {
  engine: EngineId
  cwd: string | null
  loginId: string | null
  providerId: string
  providerName: string
  method: AuthMethod
  notices: AuthFlowNotice[]
  prompt: { promptId: string; prompt: AuthFlowPrompt } | null
  status: 'running' | 'done' | 'error'
  error?: string
}

function reduceLogin(current: LoginState | null, event: AuthFlowEvent): LoginState | null {
  if (!current) return current
  switch (event.kind) {
    case 'notice':
      return {
        ...current,
        notices: [
          ...current.notices.filter((n) => n.type !== event.notice.type || n.type === 'info'),
          event.notice
        ]
      }
    case 'prompt':
      return { ...current, prompt: { promptId: event.promptId, prompt: event.prompt } }
    case 'prompt-cancelled':
      return current.prompt?.promptId === event.promptId ? { ...current, prompt: null } : current
    case 'done':
      if (event.cancelled) return null
      return { ...current, prompt: null, status: event.ok ? 'done' : 'error', error: event.error }
  }
}

export function useLoginFlow(onDone?: (ok: boolean, providerId: string) => void) {
  const [state, setState] = useState<LoginState | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const loginIdRef = useRef<string | null>(null)
  const engineRef = useRef<EngineId>('pi')
  const cwdRef = useRef<string | null>(null)
  const providerRef = useRef('')
  const attemptRef = useRef(0)
  // Main may emit the first events before `auth-login` resolves with the id; buffer them meanwhile.
  const pendingRef = useRef<AuthFlowEvent[] | null>(null)

  const apply = useCallback((event: AuthFlowEvent) => {
    setState((current) => reduceLogin(current, event))
    if (event.kind === 'done' && !event.cancelled) doneRef.current?.(event.ok, providerRef.current)
  }, [])

  useEffect(
    () =>
      on('settings:auth-event', (event) => {
        if ((event.engine ?? 'pi') !== engineRef.current) return
        if (pendingRef.current) pendingRef.current.push(event)
        else if (event.loginId === loginIdRef.current) apply(event)
      }),
    [apply]
  )

  const start = useCallback(
    async (
      provider: Pick<ProviderInfo, 'id' | 'name'>,
      method: AuthMethod,
      options?: { cwd?: string | null; engine?: EngineId }
    ) => {
      const attempt = ++attemptRef.current
      const engine = options?.engine ?? useSettings.getState().engine
      const cwd = options?.cwd === undefined ? activeCwd() : options.cwd
      engineRef.current = engine
      cwdRef.current = cwd
      loginIdRef.current = null
      pendingRef.current = []
      providerRef.current = provider.id
      setState({
        engine,
        cwd,
        loginId: null,
        providerId: provider.id,
        providerName: providerName(provider),
        method,
        notices: [],
        prompt: null,
        status: 'running'
      })
      try {
        const loginId = await settingsInvokeForFolder(engine, cwd, 'settings:auth-login', {
          providerId: provider.id,
          method,
          cwd: cwd ?? undefined
        })
        if (attemptRef.current !== attempt || !pendingRef.current) {
          // Closed or replaced before the flow had an id.
          void settingsInvokeForFolder(engine, cwd, 'settings:auth-cancel', loginId)
          return
        }
        const buffered = pendingRef.current
        pendingRef.current = null
        loginIdRef.current = loginId
        setState((current) => (current ? { ...current, loginId } : current))
        for (const event of buffered) if (event.loginId === loginId) apply(event)
      } catch (error) {
        if (attemptRef.current !== attempt) return
        pendingRef.current = null
        setState((current) =>
          current ? { ...current, status: 'error', error: (error as Error).message } : current
        )
      }
    },
    [apply]
  )

  const respond = useCallback((value: string) => {
    const current = stateRef.current
    if (!current?.loginId || !current.prompt) return
    void settingsInvokeForFolder(
      engineRef.current,
      cwdRef.current,
      'settings:auth-respond',
      current.loginId,
      current.prompt.promptId,
      value
    )
    setState({ ...current, prompt: null })
  }, [])

  const close = useCallback(() => {
    attemptRef.current += 1
    const current = stateRef.current
    if (current?.loginId && current.status === 'running')
      void settingsInvokeForFolder(
        engineRef.current,
        cwdRef.current,
        'settings:auth-cancel',
        current.loginId
      )
    loginIdRef.current = null
    pendingRef.current = null
    setState(null)
  }, [])

  useEffect(
    () => () => {
      attemptRef.current += 1
      const current = stateRef.current
      if (current?.loginId && current.status === 'running') {
        void settingsInvokeForFolder(
          engineRef.current,
          cwdRef.current,
          'settings:auth-cancel',
          current.loginId
        )
      }
      pendingRef.current = null
    },
    []
  )

  return { state, start, respond, close }
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      variant="secondary"
      leading={copied ? <Check /> : <Copy />}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

function SecretInput({
  prompt,
  onSubmit
}: {
  prompt: AuthFlowPrompt & { type: 'secret' | 'text' | 'manual_code' }
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const secret = prompt.type === 'secret'
  // Only keys must be non-empty; the engine validates text answers itself ("blank for github.com").
  const canSubmit = !secret || value.trim() !== ''
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) onSubmit(value.trim())
      }}
    >
      <label className="block text-sm text-fg-2">{prompt.message}</label>
      <div className="relative">
        <Input
          autoFocus
          type={secret && !reveal ? 'password' : 'text'}
          value={value}
          spellCheck={false}
          autoComplete="off"
          placeholder={prompt.placeholder ?? (secret ? 'sk-…' : '')}
          onChange={(e) => setValue(e.target.value)}
          className={cn('h-10 bg-surface-1 font-mono text-sm', FOCUS_RING, secret && 'pr-10')}
        />
        {secret && (
          <button
            type="button"
            aria-label={reveal ? 'Hide key' : 'Show key'}
            onClick={() => setReveal((r) => !r)}
            className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
          >
            {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {secret ? 'Save key' : 'Continue'}
        </Button>
      </div>
    </form>
  )
}

/**
 * A code prompt that runs alongside a local callback server: the browser usually completes the sign-in, and
 * pasting is the fallback ("Complete login in your browser, or paste", a localhost redirect placeholder).
 */
function isCallbackFallback(prompt: AuthFlowPrompt): boolean {
  if (prompt.type !== 'manual_code') return false
  return (
    /\bor paste\b/i.test(prompt.message) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(prompt.placeholder ?? '')
  )
}

function PromptView({
  prompt,
  onSubmit,
  hasBrowser,
  hasDeviceCode
}: {
  prompt: AuthFlowPrompt
  onSubmit: (value: string) => void
  hasBrowser: boolean
  hasDeviceCode: boolean
}) {
  // Device flow: the code is approved on the provider's page; nothing to type here.
  if (prompt.type === 'manual_code' && hasDeviceCode) {
    return (
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 text-sm text-fg-3">{prompt.message}</span>
        <Button variant="primary" onClick={() => onSubmit('')}>
          Continue
        </Button>
      </div>
    )
  }
  if (prompt.type === 'select') {
    return (
      <div className="space-y-2">
        <div className="text-sm text-fg-2">{prompt.message}</div>
        {prompt.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onSubmit(option.id)}
            className="flex w-full flex-col items-start rounded-card bg-surface-1 px-3.5 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-hover"
          >
            <span className="text-ui font-medium text-fg">{option.label}</span>
            {option.description && (
              <span className="mt-0.5 text-sm text-fg-3">{option.description}</span>
            )}
          </button>
        ))}
      </div>
    )
  }
  if (hasBrowser && isCallbackFallback(prompt)) {
    return (
      <details className="group rounded-card bg-surface-1 px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--hairline)]">
        <summary className="flex cursor-default list-none items-center gap-1.5 text-sm text-fg-3 select-none group-open:mb-3 hover:text-fg-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
          Signing in on another device? Paste the code instead
        </summary>
        <SecretInput prompt={prompt} onSubmit={onSubmit} />
      </details>
    )
  }
  return <SecretInput prompt={prompt} onSubmit={onSubmit} />
}

function NoticeView({ notice }: { notice: AuthFlowNotice }) {
  switch (notice.type) {
    case 'auth_url':
      return (
        <div className="rounded-card bg-surface-1 p-3.5 shadow-[inset_0_0_0_1px_var(--hairline)]">
          <div className="flex items-center gap-2 text-ui font-medium text-fg">
            <ExternalLink className="size-4 text-fg-3" />
            Your browser opened the sign-in page
          </div>
          <p className="mt-1 text-sm text-fg-3">
            {notice.instructions ?? 'Finish signing in there, then come back.'}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-surface-3 px-2 py-1 font-mono text-xs text-fg-3">
              {notice.url}
            </code>
            <CopyButton text={notice.url} label="Copy link" />
          </div>
        </div>
      )
    case 'device_code':
      return (
        <div className="rounded-card bg-surface-1 p-4 text-center shadow-[inset_0_0_0_1px_var(--hairline)]">
          <div className="text-sm text-fg-3">Enter this code at</div>
          <div className="mt-0.5 font-mono text-sm text-fg-2">
            {notice.verificationUri.replace(/^https?:\/\//, '')}
          </div>
          <div className="heading my-3 font-mono text-3xl font-semibold tracking-[0.18em] text-fg">
            {notice.userCode}
          </div>
          <div className="flex justify-center gap-2">
            <CopyButton text={notice.userCode} label="Copy code" />
            <Button
              size="sm"
              variant="secondary"
              leading={<ExternalLink />}
              onClick={() => void invoke('sys:open-external', notice.verificationUri)}
            >
              Open page
            </Button>
          </div>
          {notice.expiresInSeconds && (
            <div className="mt-3 text-xs text-fg-3">
              Expires in {Math.round(notice.expiresInSeconds / 60)} minutes
            </div>
          )}
        </div>
      )
    case 'info':
      return (
        <div className="text-sm text-fg-2">
          {notice.message}
          {notice.links?.map((link) => (
            <button
              key={link.url}
              type="button"
              onClick={() => void invoke('sys:open-external', link.url)}
              className="ml-1.5 text-info hover:underline"
            >
              {link.label ?? link.url}
            </button>
          ))}
        </div>
      )
    case 'progress':
      return (
        <div className="flex items-center gap-2 text-sm text-fg-3">
          <Spinner size={13} />
          {notice.message}
        </div>
      )
  }
}

export function LoginDialog({ flow }: { flow: ReturnType<typeof useLoginFlow> }) {
  const { state, respond, close } = flow
  useEffect(() => {
    if (state?.status !== 'done') return
    toast({ level: 'success', title: `${state.providerName} connected` })
    const timer = setTimeout(close, 1100)
    return () => clearTimeout(timer)
  }, [state?.status, state?.providerName, close])

  const oauth = state?.method === 'oauth'
  const hasBrowser = !!state?.notices.some((n) => n.type === 'auth_url')
  const hasDeviceCode = !!state?.notices.some((n) => n.type === 'device_code')
  const progress = state?.notices.filter((n) => n.type === 'progress').at(-1)
  const pendingStatus: AuthFlowNotice = {
    type: 'progress',
    message:
      hasBrowser || hasDeviceCode ? 'Waiting for you to approve in the browser…' : 'Starting…'
  }
  return (
    <Dialog
      open={!!state}
      onOpenChange={(open) => !open && close()}
      icon={oauth ? <ShieldCheck /> : <KeyRound />}
      title={
        oauth ? `Sign in to ${state?.providerName ?? ''}` : `${state?.providerName ?? ''} API key`
      }
      description={
        oauth
          ? state?.providerId.startsWith('mcp:')
            ? 'Authorize this connection through the service’s own sign-in.'
            : 'Uses the provider’s own sign-in.'
          : 'Stored by the engine in its auth file. Vengeance never displays it again.'
      }
    >
      {state && (
        <div className="space-y-3.5">
          <AnimatePresence mode="popLayout" initial={false}>
            {state.status === 'done' ? (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-2 py-6 text-center"
              >
                <CheckCircle2 className="size-10 text-success" />
                <div className="text-md font-medium text-fg">Connected</div>
              </motion.div>
            ) : state.status === 'error' ? (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-start gap-3 rounded-card bg-danger-soft p-3.5"
              >
                <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                <div className="min-w-0 text-sm text-fg-2">
                  <div className="font-medium text-danger">Sign-in failed</div>
                  <div className="mt-0.5 break-words">{state.error ?? 'Unknown error'}</div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="run"
                className="space-y-3.5"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                {state.notices
                  .filter((n) => n.type !== 'progress')
                  .map((notice, i) => (
                    <NoticeView key={`${notice.type}-${i}`} notice={notice} />
                  ))}
                {state.prompt && (
                  <PromptView
                    prompt={state.prompt.prompt}
                    onSubmit={respond}
                    hasBrowser={hasBrowser}
                    hasDeviceCode={hasDeviceCode}
                  />
                )}
                {!state.prompt && <NoticeView notice={progress ?? pendingStatus} />}
                {state.prompt && progress && hasBrowser && <NoticeView notice={progress} />}
              </motion.div>
            )}
          </AnimatePresence>
          {state.status === 'error' && (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  void flow.start(
                    { id: state.providerId, name: state.providerName },
                    state.method,
                    { cwd: state.cwd, engine: state.engine }
                  )
                }
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
