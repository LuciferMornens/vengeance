import { memo, useContext, useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle,
  ChevronRight,
  ChevronUp,
  GitBranch,
  Layers,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Square
} from 'lucide-react'
import { friendlyExtensionName } from '@shared/display-names'
import type { EngineId } from '@shared/api/engine'
import type {
  AssistantMessage,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage
} from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import { formatTokens } from '../../lib/format'
import { spring } from '../../lib/motion'
import type { AgentState, BashRun, CompactionState, RetryState } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { Badge, Button, Shimmer, Spinner } from '../../ui'
import { Collapse } from '../../ui/Collapse'
import { CopyButton } from '../../ui/CopyButton'
import { Markdown } from '../../ui/Markdown'
import { SIGN_IN_EXPIRED } from '../settings/provider-status'
import { Console, ExitBadge, PromptIcon } from '../tools'
import { useCatalogProviders } from './catalog-providers'
import { EarlierHistoryContext } from './earlier-history'
import { openSignIn } from './failure-toast'
import { expiredSignInName, parseProviderError, type ParsedProviderError } from './provider-error'

/** Hairline — label — hairline separator for session events. */
function Divider({
  icon,
  children,
  onClick,
  open
}: {
  icon: ReactNode
  children: ReactNode
  onClick?: () => void
  open?: boolean
}) {
  const Label = onClick ? 'button' : 'span'
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-fg-3">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-[var(--hairline-strong)]" />
      <Label
        {...(onClick ? { type: 'button' as const, onClick } : {})}
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 [&>svg]:size-3.5',
          onClick && 'transition-colors hover:bg-hover hover:text-fg-2'
        )}
      >
        {icon}
        {children}
        {onClick && (
          <ChevronRight
            className={cn(
              '!size-3 transition-transform duration-[var(--dur-base)]',
              open && 'rotate-90'
            )}
          />
        )}
      </Label>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-[var(--hairline-strong)]" />
    </div>
  )
}

function SummaryPanel({ text }: { text: string }) {
  return (
    <div className="mx-auto mt-2 mb-1 max-w-[620px] rounded-card bg-surface-2 px-4 py-3 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
      <Markdown text={text} size="compact" />
    </div>
  )
}

/** Above a leading compaction divider: loads (or hides) the messages it summarized, which show above it. */
function EarlierMessagesToggle() {
  const earlier = useContext(EarlierHistoryContext)
  if (!earlier.available) return null
  return (
    <div className="flex justify-center pb-1">
      <button
        type="button"
        onClick={earlier.toggle}
        disabled={earlier.loading}
        className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 disabled:pointer-events-none"
      >
        {earlier.loading ? (
          <Spinner size={11} />
        ) : (
          <ChevronUp
            className={cn(
              'size-3.5 transition-transform duration-[var(--dur-base)]',
              earlier.entries && 'rotate-180'
            )}
          />
        )}
        {earlier.entries ? 'Hide earlier messages' : 'Show earlier messages'}
      </button>
    </div>
  )
}

/** `leading`: the transcript starts here (a reopened session), so the summarized messages can be loaded above it. */
export const CompactionNote = memo(function CompactionNote({
  message,
  leading
}: {
  message: CompactionSummaryMessage
  leading: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      {leading && <EarlierMessagesToggle />}
      <Divider icon={<Layers />} onClick={() => setOpen((v) => !v)} open={open}>
        <span>
          Context compacted · <span className="tabular">{formatTokens(message.tokensBefore)}</span>{' '}
          tokens summarized
        </span>
      </Divider>
      <Collapse open={open}>
        <SummaryPanel text={message.summary} />
      </Collapse>
    </div>
  )
})

export function CompactingNote({ compaction }: { compaction: CompactionState }) {
  return (
    <Divider icon={<Layers className="animate-[v-pulse_1.4s_ease-in-out_infinite] text-fg-2" />}>
      <Shimmer>
        {compaction.reason === 'manual'
          ? 'Compacting context…'
          : 'Context is getting long — compacting…'}
      </Shimmer>
    </Divider>
  )
}

export const BranchSummaryNote = memo(function BranchSummaryNote({
  message
}: {
  message: BranchSummaryMessage
}) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <Divider icon={<GitBranch />} onClick={() => setOpen((v) => !v)} open={open}>
        Summary of the branch you left
      </Divider>
      <Collapse open={open}>
        <SummaryPanel text={message.summary} />
      </Collapse>
    </div>
  )
})

function customText(message: CustomMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}

export const CustomMessageCard = memo(function CustomMessageCard({
  message
}: {
  message: CustomMessage
}) {
  const label = friendlyExtensionName(message.customType)
  const images =
    typeof message.content === 'string' ? [] : message.content.filter((c) => c.type === 'image')
  return (
    <div className="rounded-card bg-surface-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
      <div className="flex h-8 items-center gap-2 border-b border-hairline-soft px-3.5 text-xs text-fg-3">
        <Puzzle className="size-3.5" />
        <span className="font-medium text-fg-2" title={message.customType}>
          {label}
        </span>
        <span className="ml-auto">Extension</span>
      </div>
      <div className="px-3.5 py-3">
        <Markdown text={customText(message)} size="compact" />
        {images.map((image, i) => (
          <img
            key={i}
            src={`data:${image.mimeType};base64,${image.data}`}
            alt=""
            className="mt-2 max-h-64 rounded-md"
          />
        ))}
      </div>
    </div>
  )
})

export function UnknownNote({ role }: { role: string }) {
  return <Divider icon={<Puzzle />}>{role} message</Divider>
}

export function AbortedNote() {
  return (
    <div className="flex items-center gap-2 text-sm text-fg-3">
      <span className="flex size-4 items-center justify-center rounded-xs bg-hover">
        <Square className="size-2 fill-current" />
      </span>
      Stopped
    </div>
  )
}

export function ErrorCard({
  title,
  detail,
  meta,
  raw,
  action
}: {
  title: string
  detail?: string
  meta?: string
  raw?: string
  action?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-card bg-[color-mix(in_oklab,var(--danger)_6%,var(--surface-2))] shadow-[0_0_0_1px_var(--danger-border)]">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
          <AlertTriangle className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-fg">{title}</div>
          {detail && (
            <div className="selectable mt-0.5 text-sm break-words text-fg-2">{detail}</div>
          )}
          <div className="mt-1.5 flex items-center gap-2">
            {meta && <span className="font-mono text-2xs text-fg-3">{meta}</span>}
            {raw && raw !== title && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="text-2xs font-medium text-fg-3 hover:text-fg"
              >
                {open ? 'Hide details' : 'Details'}
              </button>
            )}
          </div>
        </div>
        {action}
      </div>
      <Collapse open={open}>
        <pre className="selectable max-h-48 overflow-auto border-t border-[color-mix(in_oklab,var(--danger)_18%,transparent)] px-3.5 py-2.5 font-mono text-[11.5px] break-all whitespace-pre-wrap text-fg-2">
          {raw}
        </pre>
      </Collapse>
    </div>
  )
}

function lastEntryIs(agent: AgentState | undefined, message: AssistantMessage): boolean {
  return !!agent && agent.entries[agent.entries.length - 1]?.message === message
}

/** The automatic retries ended on this failed response (the Engine's final error is its error). */
export function retriesGaveUpOn(agent: AgentState | undefined, message: AssistantMessage): boolean {
  return (
    !!agent?.retryError &&
    agent.phase === 'idle' &&
    agent.retryError === message.errorMessage &&
    lastEntryIs(agent, message)
  )
}

function gaveUpTitle(title: string): string {
  return `Gave up retrying — ${title.charAt(0).toLowerCase()}${title.slice(1)}`
}

/** A failure of an Engine sign-in the provider refused to renew: its provider by name, and Sign in again. */
function ExpiredSignInCard({
  parsed,
  provider,
  title,
  model
}: {
  parsed: ParsedProviderError
  provider: string
  title: string
  model?: string
}) {
  const providers = useCatalogProviders('pi')
  return (
    <ErrorCard
      title={title}
      detail={parsed.detail}
      meta={[expiredSignInName(provider, providers), model].filter(Boolean).join(' · ')}
      raw={parsed.raw}
      action={
        <Button
          size="sm"
          variant="secondary"
          leading={<ShieldCheck />}
          className="shrink-0"
          onClick={() => openSignIn(provider)}
        >
          {SIGN_IN_EXPIRED.action}
        </Button>
      }
    />
  )
}

/**
 * A failed response. While an automatic retry of it is pending, the retry banner speaks for it instead; once the
 * retries ran out, the card says so (one card for the turn).
 */
export const AssistantErrorCard = memo(function AssistantErrorCard({
  agentId,
  message
}: {
  agentId: string
  message: AssistantMessage
}) {
  const retrying = useAgents(
    (s) => !!s.agents[agentId]?.retry && lastEntryIs(s.agents[agentId], message)
  )
  const gaveUp = useAgents((s) => retriesGaveUpOn(s.agents[agentId], message))
  if (retrying) return null
  const parsed = parseProviderError(message.errorMessage)
  const title = gaveUp ? gaveUpTitle(parsed.title) : parsed.title
  if (parsed.expiredSignIn)
    return (
      <ExpiredSignInCard
        parsed={parsed}
        provider={parsed.expiredSignIn}
        title={title}
        model={message.model}
      />
    )
  const meta = [parsed.status, parsed.code, message.model].filter(Boolean).join(' · ')
  return <ErrorCard title={title} detail={parsed.detail} meta={meta} raw={parsed.raw} />
})

/**
 * A failed response that an automatic retry recovered from: a quiet note, not an error card. When the Engine
 * compacted the context in between, the failure was a context overflow it recovered from.
 */
export const RetriedNote = memo(function RetriedNote({
  message,
  compacted
}: {
  message: AssistantMessage
  compacted: boolean
}) {
  const parsed = parseProviderError(message.errorMessage)
  return (
    <div className="flex items-center gap-2 text-sm text-fg-3" title={parsed.raw}>
      {compacted ? <Layers className="size-3.5" /> : <RefreshCw className="size-3.5" />}
      <span>
        {compacted
          ? 'Context too long · compacted and retried'
          : `${parsed.title} · retried automatically`}
      </span>
    </div>
  )
})

/** Draining countdown ring (warning stroke on a hairline track). */
function CountdownRing({ progress }: { progress: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className="-rotate-90 shrink-0" aria-hidden>
      <circle cx={8} cy={8} r={r} fill="none" stroke="var(--hairline-strong)" strokeWidth={1.75} />
      <circle
        cx={8}
        cy={8}
        r={r}
        fill="none"
        stroke="var(--warning)"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * Math.min(1, progress)}
      />
    </svg>
  )
}

/** pi ends a retry only after the retried turn completes; the countdown is relevant until that turn starts. */
export function retryPending(agent: AgentState): boolean {
  return agent.retry !== null && !agent.turnActive
}

/** SPEC §3.2 retry state: "Retrying in 3s · attempt 2/5" with a countdown ring and Cancel (abort_retry). */
function RetryBanner({ agentId, retry }: { agentId: string; retry: RetryState }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])
  const remaining = Math.max(0, retry.startedAt + retry.delayMs - now)
  const seconds = Math.ceil(remaining / 1000)
  const parsed = parseProviderError(retry.errorMessage)
  const progress = retry.delayMs > 0 ? 1 - remaining / retry.delayMs : 1
  return (
    <div
      data-retry-banner
      className="flex items-center gap-3 rounded-card bg-[var(--glass-strong)] py-2.5 pr-2.5 pl-3.5 shadow-[var(--highlight),0_0_0_1px_var(--warning-border)] backdrop-blur-xl"
    >
      {remaining > 0 ? (
        <CountdownRing progress={progress} />
      ) : (
        <RefreshCw className="size-4 shrink-0 animate-[v-spin_1s_linear_infinite] text-warning" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-ui text-fg">
          {remaining > 0 ? (
            <>
              Retrying in <span className="tabular font-medium">{seconds}s</span>
            </>
          ) : (
            <Shimmer>Retrying now…</Shimmer>
          )}
          <span className="text-fg-3">
            {' '}
            · attempt{' '}
            <span className="tabular">
              {retry.attempt}/{retry.maxAttempts}
            </span>
          </span>
        </div>
        <div className="truncate text-xs text-fg-3" title={parsed.raw}>
          {parsed.title}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void rpc(agentId, { type: 'abort_retry' }).catch(() => undefined)}
      >
        Cancel
      </Button>
    </div>
  )
}

/**
 * The pending retry countdown, docked above the composer's editor: it counts toward `--composer-h`, so the
 * transcript padding and the toasts clear it. Finished retries stay in the transcript (RetriedNote, RetryFailedCard).
 */
export function RetryNotice({ agentId }: { agentId: string }) {
  const retry = useAgents((s) => {
    const agent = s.agents[agentId]
    return agent && retryPending(agent) ? agent.retry : null
  })
  return (
    <AnimatePresence initial={false}>
      {retry && (
        <motion.div
          key="retry"
          layout="position"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={spring.snappy}
          className="pointer-events-auto mb-1.5"
        >
          <RetryBanner agentId={agentId} retry={retry} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** The retries' final error when no failed response at the end of the transcript carries it (AssistantErrorCard). */
export function RetryFailedCard({ message }: { message: string }) {
  const parsed = parseProviderError(message)
  const title = gaveUpTitle(parsed.title)
  if (parsed.expiredSignIn)
    return <ExpiredSignInCard parsed={parsed} provider={parsed.expiredSignIn} title={title} />
  return <ErrorCard title={title} detail={parsed.detail} raw={parsed.raw} />
}

/** A user `!command` run: "You ran" console card (live while running). */
export const BashExecutionCard = memo(function BashExecutionCard({
  engine,
  command,
  output,
  exitCode,
  running,
  cancelled,
  truncated,
  excludeFromContext
}: {
  engine: EngineId
  command: string
  output: string
  exitCode?: number
  running: boolean
  cancelled?: boolean
  truncated?: boolean
  excludeFromContext?: boolean
}) {
  return (
    <div className="overflow-hidden rounded-card bg-surface-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
      <div className="flex h-[38px] items-center gap-2.5 px-3 text-sm">
        <span className="flex size-4 items-center justify-center text-accent-text [&_svg]:size-[15px]">
          <PromptIcon />
        </span>
        <span className="font-medium text-fg">{running ? 'Running' : 'You ran'}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">{command}</span>
        {cancelled ? <Badge>cancelled</Badge> : !running && <ExitBadge code={exitCode} />}
      </div>
      <Console command={command} output={output} live={running} />
      {engine === 'prime' && !running && !excludeFromContext && (
        <div className="flex items-start gap-3 border-t border-hairline-soft px-3.5 py-2.5">
          <p className="flex-1 text-xs leading-relaxed text-fg-3">
            Engine 2 may not use this shell output in the next turn. Paste the relevant output into
            your message.
          </p>
          <CopyButton value={output} label="Copy output" showLabel className="shrink-0" />
        </div>
      )}
      {truncated && (
        <div className="border-t border-hairline-soft px-3.5 py-2 text-xs text-fg-3">
          Output truncated
        </div>
      )}
    </div>
  )
})

export function BashMessageCard({
  agentId,
  message
}: {
  agentId: string
  message: BashExecutionMessage
}) {
  const engine = useAgents((state) => state.agents[agentId]?.info.engine ?? 'pi')
  return (
    <BashExecutionCard
      engine={engine}
      command={message.command}
      output={message.output}
      exitCode={message.exitCode}
      running={false}
      cancelled={message.cancelled}
      truncated={message.truncated}
      excludeFromContext={message.excludeFromContext}
    />
  )
}

export function BashRunCard({ agentId, run }: { agentId: string; run: BashRun }) {
  const engine = useAgents((state) => state.agents[agentId]?.info.engine ?? 'pi')
  return (
    <BashExecutionCard
      engine={engine}
      command={run.command}
      output={run.result?.output ?? run.output}
      exitCode={run.result?.exitCode}
      running={run.running}
      cancelled={run.result?.cancelled}
      truncated={run.result?.truncated}
      excludeFromContext={run.excludeFromContext}
    />
  )
}
