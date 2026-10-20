import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LogOut,
  Plug,
  RefreshCw,
  Search,
  ShieldCheck,
  Zap
} from 'lucide-react'
import type { AuthCheckResult, ProviderInfo } from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import { settingsInvokeForFolder } from '../ipc'
import { useApp } from '../../../store/app'
import { Badge, Button, IconButton, Input, Skeleton, toast, Tooltip } from '../../../ui'
import { LoginDialog, useLoginFlow } from '../auth-flow'
import { Callout, Group, Note, Row } from '../layout'
import { useCatalog } from '../model-picker'
import { CHATGPT_PROVIDER, CODEX_PROVIDER, providerName, signInPlan } from '../provider-name'
import { hasCredential, providerUsable, SIGN_IN_EXPIRED, signInExpired } from '../provider-status'
import { useSettings } from '../store'

/** Deterministic monogram tile for a provider (no third-party logos bundled). */
export function ProviderAvatar({
  provider,
  size = 32
}: {
  provider: Pick<ProviderInfo, 'id' | 'name'>
  size?: number
}) {
  let hash = 0
  for (const ch of provider.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const hue = hash % 360
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-card font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_0_0_1px_rgba(0,0,0,0.12)]"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(140deg, oklch(0.68 0.15 ${hue}), oklch(0.5 0.16 ${(hue + 40) % 360}))`
      }}
    >
      {providerName(provider)
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 1)
        .toUpperCase()}
    </span>
  )
}

/**
 * How a connected provider authenticates: always a neutral label (auth kind is data, not a state). Null when
 * an extension supplies the credential; its Extension badge says that.
 */
function credentialLabel(p: ProviderInfo): string | null {
  if (p.stored?.type === 'oauth') return p.oauth?.subscription ? 'Subscription' : 'Signed in'
  if (p.stored?.type === 'api_key')
    return p.stored.command ? 'Key command' : `API key ${p.stored.hint ?? ''}`.trim()
  if (p.status.source === 'environment') return p.status.label ?? 'Environment variable'
  if (p.status.source === 'models_json_key' || p.status.source === 'models_json_command')
    return 'Custom models'
  return p.status.label ?? (p.fromExtension ? null : 'Configured')
}

/** What a stored credential would take precedence over (models.md: stored, then models.json, then environment). */
function overriddenSource(p: ProviderInfo): string {
  if (p.status.source === 'environment') return 'the environment variable'
  if (p.status.source === 'models_json_key' || p.status.source === 'models_json_command')
    return 'the key in models.json'
  return p.fromExtension ? 'the key from the extension' : 'the current credential'
}

function EnvVars({ provider, inset }: { provider: ProviderInfo; inset: string }) {
  if (provider.envVars.length === 0) return null
  return (
    <span className={cn(inset, 'flex flex-wrap gap-x-3 font-mono text-xs text-fg-3')}>
      {provider.envVars.map((name) => (
        <span key={name}>{name}</span>
      ))}
    </span>
  )
}

function ExtensionBadge({ provider }: { provider: ProviderInfo }) {
  return provider.fromExtension ? <Badge>Extension</Badge> : null
}

/** A built-in provider an extension changes stays a built-in; a quiet note names the extension. */
function ModifiedBy({ provider }: { provider: ProviderInfo }) {
  return provider.modifiedBy ? <> · modified by {provider.modifiedBy}</> : null
}

function CheckResult({ result }: { result: AuthCheckResult | 'loading' | undefined }) {
  if (!result) return null
  if (result === 'loading') return <Badge>Testing…</Badge>
  if (result.status === 'ready')
    return (
      <Badge tone="success">
        <CheckCircle2 className="mr-1 size-3" />
        Ready
      </Badge>
    )
  return (
    <Tooltip content={result.reason ?? result.detail ?? 'Not ready'}>
      <span>
        <Badge tone="warning">
          <CircleAlert className="mr-1 size-3" />
          {result.status === 'invalid' ? 'Invalid' : 'Not ready'}
        </Badge>
      </span>
    </Tooltip>
  )
}

type StartLogin = (p: ProviderInfo, method: 'oauth' | 'api_key') => void
type Check = AuthCheckResult | 'loading' | undefined

function ProviderTitle({ provider, size }: { provider: ProviderInfo; size?: number }) {
  return (
    <span className="flex items-center gap-3">
      <ProviderAvatar provider={provider} size={size} />
      <span>{providerName(provider)}</span>
    </span>
  )
}

/**
 * A provider with a credential: what it is, a test, and the matching reconnect / replace / sign-out actions. A sign-in
 * the provider refused to renew reads as expired, with Sign in again as its main action.
 */
function ConnectedRow({
  provider: p,
  check,
  onTest,
  onStart,
  onSignOut,
  badges,
  detail
}: {
  provider: ProviderInfo
  check: Check
  onTest: () => void
  onStart: StartLogin
  onSignOut: () => void
  badges?: ReactNode
  detail?: ReactNode
}) {
  const expired = signInExpired(p)
  const credential = expired ? null : credentialLabel(p)
  const expiredId = useId()
  return (
    <Row
      settingKey={`provider.${p.id}`}
      label={<ProviderTitle provider={p} />}
      badges={
        <>
          {credential && <Badge>{credential}</Badge>}
          {expired && (
            <Badge tone="warning">
              <CircleAlert className="mr-1 size-3" />
              {SIGN_IN_EXPIRED.label}
            </Badge>
          )}
          {badges}
          <ExtensionBadge provider={p} />
          <CheckResult result={check} />
        </>
      }
      description={
        <>
          {expired && (
            <span id={expiredId} className="ml-11 block text-pretty text-warning">
              {SIGN_IN_EXPIRED.explanation}
            </span>
          )}
          {(!expired || providerUsable(p)) && (
            <span className="ml-11 block">
              {p.availableCount} {p.availableCount === 1 ? 'model' : 'models'}
              {!expired && p.stored?.expiresAt && p.stored.type === 'oauth' && (
                <> · token refreshes automatically</>
              )}
              {p.status.source === 'environment' && <> · from the environment</>}
              <ModifiedBy provider={p} />
            </span>
          )}
          {detail && <span className="ml-11 block">{detail}</span>}
        </>
      }
    >
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          leading={<Zap />}
          loading={check === 'loading'}
          onClick={onTest}
        >
          Test
        </Button>
        {p.oauth && expired && (
          <Button
            size="sm"
            variant="secondary"
            leading={<ShieldCheck />}
            aria-describedby={expiredId}
            onClick={() => onStart(p, 'oauth')}
          >
            {SIGN_IN_EXPIRED.action}
          </Button>
        )}
        {p.oauth && p.stored?.type === 'oauth' && !expired && (
          <Button size="sm" variant="ghost" onClick={() => onStart(p, 'oauth')}>
            Reconnect
          </Button>
        )}
        {p.apiKey && p.stored?.type === 'api_key' && (
          <Button size="sm" variant="ghost" onClick={() => onStart(p, 'api_key')}>
            Replace key
          </Button>
        )}
        {!p.stored && p.apiKey && (
          <Tooltip content={`A stored key takes precedence over ${overriddenSource(p)}.`}>
            <Button size="sm" variant="ghost" onClick={() => onStart(p, 'api_key')}>
              API key
            </Button>
          </Tooltip>
        )}
        {p.oauth && p.stored?.type !== 'oauth' && (
          <Tooltip
            content={
              p.stored?.type === 'api_key'
                ? 'Completing sign-in replaces the saved API key.'
                : `Signing in takes precedence over ${overriddenSource(p)}.`
            }
          >
            <Button size="sm" variant="ghost" onClick={() => onStart(p, 'oauth')}>
              {p.oauth.loginLabel ?? 'Sign in'}
            </Button>
          </Tooltip>
        )}
        {p.stored && (
          <IconButton
            label={p.stored.type === 'oauth' ? 'Sign out' : 'Remove key'}
            size="sm"
            onClick={onSignOut}
          >
            <LogOut />
          </IconButton>
        )}
      </div>
    </Row>
  )
}

/** A subscription sign-in that is not connected yet. `plan`: lead the line with the plan the sign-in uses. */
function SignInRow({
  provider: p,
  onStart,
  badges,
  detail,
  plan = true
}: {
  provider: ProviderInfo
  onStart: StartLogin
  badges?: ReactNode
  detail?: ReactNode
  plan?: boolean
}) {
  const planName = plan ? signInPlan(p) : null
  return (
    <Row
      settingKey={`provider.${p.id}`}
      label={<ProviderTitle provider={p} />}
      badges={
        <>
          {badges}
          <ExtensionBadge provider={p} />
        </>
      }
      description={
        <>
          <span className="ml-11 block">
            {planName && <>{planName} · </>}
            {p.modelCount} {p.modelCount === 1 ? 'model' : 'models'}
            <ModifiedBy provider={p} />
          </span>
          {detail && <span className="ml-11 block">{detail}</span>}
          <EnvVars provider={p} inset="ml-11" />
        </>
      }
    >
      <div className="flex items-center gap-1.5">
        {p.apiKey && (
          <Button
            size="sm"
            variant="ghost"
            leading={<KeyRound />}
            onClick={() => onStart(p, 'api_key')}
          >
            API key
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          leading={<ShieldCheck />}
          onClick={() => onStart(p, 'oauth')}
        >
          {p.oauth?.loginLabel ?? 'Sign in'}
        </Button>
      </div>
    </Row>
  )
}

const CODEX_COMPAT_PACKAGE = 'pi-openai-codex-compat'

/** Whether the package that builds on the Codex sign-in (Codex compaction, Fast mode, apply_patch…) is loaded. */
function useCodexCompat(): boolean {
  const cwd = useApp((state) => state.prefs.activeWorkspace)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    settingsInvokeForFolder('pi', cwd, 'settings:packages', cwd)
      .then(
        (packages) =>
          alive &&
          setLoaded(
            packages.some(
              (pkg) =>
                pkg.name === CODEX_COMPAT_PACKAGE && pkg.installed && pkg.resources.extensions > 0
            )
          )
      )
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [cwd])
  return loaded
}

/**
 * The two ChatGPT sign-ins side by side: the official one (`openai`: Sign in with ChatGPT, also OpenAI API keys) and
 * the Engine's legacy Codex sign-in (`openai-codex`), each with what it is for.
 */
function ChatGptGroup({
  providers,
  checks,
  onTest,
  onStart,
  onSignOut
}: {
  providers: ProviderInfo[]
  checks: Record<string, Check>
  onTest: (p: ProviderInfo) => void
  onStart: StartLogin
  onSignOut: (p: ProviderInfo) => void
}) {
  const nativeCompaction = useApp((s) => s.prefs.features.settings?.nativeCompaction !== false)
  const codexCompat = useCodexCompat()
  const detailOf = (p: ProviderInfo): string => {
    if (p.id === CODEX_PROVIDER) {
      return codexCompat
        ? 'Codex’s own sign-in. OpenAI Codex compat needs it for Codex compaction, Fast mode, apply_patch and web search.'
        : 'Codex’s own sign-in, for extensions made for Codex.'
    }
    if (p.status.configured && !p.status.usingOAuth && !signInExpired(p))
      return 'Billed to your OpenAI API account. Sign in with ChatGPT instead to use your plan.'
    return `The official sign-in: the models your plan includes${nativeCompaction ? ', with OpenAI native compaction' : ''}.`
  }
  return (
    <Group
      title="ChatGPT"
      description="Two sign-ins for the same ChatGPT plan. Use either, or both."
    >
      {providers.map((p) => {
        const badges = p.id === CODEX_PROVIDER ? <Badge>Legacy</Badge> : undefined
        return hasCredential(p) ? (
          <ConnectedRow
            key={p.id}
            provider={p}
            check={checks[p.id]}
            onTest={() => onTest(p)}
            onStart={onStart}
            onSignOut={() => onSignOut(p)}
            badges={badges}
            detail={detailOf(p)}
          />
        ) : (
          <SignInRow
            key={p.id}
            provider={p}
            onStart={onStart}
            badges={badges}
            detail={detailOf(p)}
            plan={false}
          />
        )
      })}
    </Group>
  )
}

export function ProvidersSection() {
  const engine = useSettings((state) => state.engine)
  const cwd = useApp((state) => state.prefs.activeWorkspace)
  const { catalog, loading, error } = useCatalog()
  const loadCatalog = useSettings((s) => s.loadCatalog)
  const flow = useLoginFlow((ok) => {
    if (
      ok &&
      useSettings.getState().engine === engine &&
      useApp.getState().prefs.activeWorkspace === cwd
    )
      void loadCatalog(true)
  })
  const [checks, setChecks] = useState<Record<string, Check>>({})
  const [filter, setFilter] = useState('')
  const [showAll, setShowAll] = useState(false)
  // Only this page lists the providers extensions register; reading them loads the extensions.
  useEffect(() => {
    void loadCatalog(true, true)
  }, [loadCatalog])

  const providers = useMemo(() => catalog?.providers ?? [], [catalog])
  // Both ChatGPT sign-ins get their own group, explained side by side (only when the engine has both).
  const chatgpt = useMemo(() => {
    if (engine !== 'pi') return []
    const pair = [CHATGPT_PROVIDER, CODEX_PROVIDER].flatMap((id) =>
      providers.filter((p) => p.id === id && p.oauth)
    )
    return pair.length === 2 ? pair : []
  }, [engine, providers])
  const listed = providers.filter((p) => !chatgpt.includes(p))
  const connected = listed.filter(hasCredential)
  const subscriptions = listed.filter((p) => !hasCredential(p) && p.oauth?.subscription)
  // Everything else that can be connected: API keys, and sign-ins that are not a subscription plan.
  // Providers with a sign-in come first so the collapsed list never hides them.
  const keyProviders = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return providers
      .filter(
        (p) =>
          !chatgpt.includes(p) &&
          !hasCredential(p) &&
          !p.oauth?.subscription &&
          (p.apiKey || p.oauth)
      )
      .filter(
        (p) =>
          !needle ||
          p.name.toLowerCase().includes(needle) ||
          p.id.includes(needle) ||
          p.envVars.some((e) => e.toLowerCase().includes(needle))
      )
      .sort((a, b) => Number(!!b.oauth) - Number(!!a.oauth))
  }, [providers, chatgpt, filter])
  const visibleKeys = showAll || filter ? keyProviders : keyProviders.slice(0, 8)

  const test = async (p: ProviderInfo) => {
    setChecks((c) => ({ ...c, [p.id]: 'loading' }))
    try {
      const result = await settingsInvokeForFolder(engine, cwd, 'settings:auth-check', p.id)
      setChecks((c) => ({ ...c, [p.id]: result }))
    } catch (error) {
      setChecks((c) => ({ ...c, [p.id]: { status: 'invalid', detail: (error as Error).message } }))
    }
  }

  const signOut = async (p: ProviderInfo) => {
    try {
      await settingsInvokeForFolder(engine, cwd, 'settings:auth-logout', p.id)
      if (
        useSettings.getState().engine === engine &&
        useApp.getState().prefs.activeWorkspace === cwd
      )
        await loadCatalog(true)
      setChecks(({ [p.id]: _removed, ...rest }) => rest)
      toast({ level: 'info', title: `Signed out of ${providerName(p)}` })
    } catch (error) {
      toast({ level: 'error', title: 'Sign-out failed', description: (error as Error).message })
    }
  }
  const start: StartLogin = (p, method) => void flow.start(p, method, { engine, cwd })

  if (!catalog && loading) {
    return (
      <Group title="Connected">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3.5 last:border-b-0"
          >
            <Skeleton className="size-8 rounded-card" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </Group>
    )
  }

  const chatgptConnected = chatgpt.some(hasCredential)
  return (
    <>
      {error && (
        <Callout
          tone="warning"
          icon={<Plug />}
          title="Could not load providers"
          action={
            <Button size="sm" variant="secondary" onClick={() => void loadCatalog(true, true)}>
              Try again
            </Button>
          }
        >
          {error}
        </Callout>
      )}
      <Group
        title="Connected"
        description={
          connected.some(signInExpired)
            ? 'Credentials the engine can use right now, and sign-ins to renew.'
            : 'Credentials the engine can use right now.'
        }
        actions={
          <IconButton label="Refresh" size="sm" onClick={() => void loadCatalog(true, true)}>
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </IconButton>
        }
      >
        {connected.length === 0 && (
          <Note icon={<Plug />}>
            {chatgptConnected
              ? 'Your ChatGPT sign-ins are listed below. Connect another provider here.'
              : 'No providers connected yet. Sign in with a subscription or add an API key below.'}
          </Note>
        )}
        {connected.map((p) => (
          <ConnectedRow
            key={p.id}
            provider={p}
            check={checks[p.id]}
            onTest={() => void test(p)}
            onStart={start}
            onSignOut={() => void signOut(p)}
          />
        ))}
      </Group>

      {chatgpt.length > 0 && (
        <ChatGptGroup
          providers={chatgpt}
          checks={checks}
          onTest={(p) => void test(p)}
          onStart={start}
          onSignOut={(p) => void signOut(p)}
        />
      )}

      {subscriptions.length > 0 && (
        <Group
          title="Subscriptions"
          description="Sign in with an existing plan. Your browser opens the provider’s page."
        >
          {subscriptions.map((p) => (
            <SignInRow key={p.id} provider={p} onStart={start} />
          ))}
        </Group>
      )}

      <Group
        title="API keys"
        description="Add a key or sign in. Environment variables work too."
        actions={
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter providers"
              className="h-7 bg-surface-1 pl-8 text-sm"
            />
          </div>
        }
      >
        {visibleKeys.length === 0 && <Note>No providers match “{filter}”.</Note>}
        {visibleKeys.map((p) => (
          <Row
            key={p.id}
            settingKey={`provider.${p.id}`}
            label={
              <span className="flex items-center gap-3">
                <ProviderAvatar provider={p} size={28} />
                <span>{providerName(p)}</span>
              </span>
            }
            badges={<ExtensionBadge provider={p} />}
            description={
              p.envVars.length > 0 || p.modifiedBy ? (
                <>
                  {p.modifiedBy && <span className="ml-10 block">Modified by {p.modifiedBy}</span>}
                  <EnvVars provider={p} inset="ml-10" />
                </>
              ) : undefined
            }
          >
            {p.oauth ? (
              <div className="flex items-center gap-1.5">
                {p.apiKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    leading={<KeyRound />}
                    onClick={() => start(p, 'api_key')}
                  >
                    API key
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  leading={<ShieldCheck />}
                  onClick={() => start(p, 'oauth')}
                >
                  {p.oauth.loginLabel ?? 'Sign in'}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                leading={<KeyRound />}
                onClick={() => start(p, 'api_key')}
              >
                Add key
              </Button>
            )}
          </Row>
        ))}
        {!filter && keyProviders.length > 8 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="w-full px-4 py-2.5 text-left text-sm text-fg-3 hover:bg-hover hover:text-fg-2"
          >
            {showAll ? 'Show fewer' : `Show all ${keyProviders.length} providers`}
          </button>
        )}
      </Group>

      {catalog?.error && (
        <Group title="Custom models">
          <Note tone="danger" icon={<CircleAlert />}>
            {catalog.error}
          </Note>
        </Group>
      )}

      <LoginDialog flow={flow} />
    </>
  )
}
