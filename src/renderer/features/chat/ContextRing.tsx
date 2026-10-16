import type { ReactNode } from 'react'
import { HoverCard } from 'radix-ui'
import { AlertTriangle } from 'lucide-react'
import type { ContextUsage as EngineContextUsage } from '@shared/engine-types'
import { runAction } from '../../lib/actions'
import { cn } from '../../lib/cn'
import { formatCost, formatTokens } from '../../lib/format'
import { useAgents } from '../../store/agents'
import { Badge, Button, floatingSurface, Tooltip } from '../../ui'
import { useEffectiveSetting } from '../settings/effective'

/** Over the window: the engine reports usage above 100 % until compaction runs. */
export function isOverContextLimit(percent: number): boolean {
  return percent > 100
}

/** "62%", never above "100%" (the over-limit state says the rest). */
export function contextPercentLabel(percent: number): string {
  return `${Math.min(100, Math.max(0, Math.round(percent)))}%`
}

function gaugeColor(percent: number): string {
  return percent >= 90 ? 'var(--danger)' : percent >= 70 ? 'var(--warning)' : 'var(--fg-2)'
}

/** SVG path of a pie sector from 12 o'clock, clockwise. */
function sectorPath(c: number, r: number, fraction: number): string {
  if (fraction >= 0.999) return `M ${c} ${c - r} A ${r} ${r} 0 1 1 ${c - 0.01} ${c - r} Z`
  const angle = fraction * 2 * Math.PI
  const x = c + r * Math.sin(angle)
  const y = c - r * Math.cos(angle)
  return `M ${c} ${c} L ${c} ${c - r} A ${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`
}

/**
 * The one context-window gauge (header, composer footer): a hairline ring with a filled sector (reads as a
 * fill level, never as a spinner). Neutral below 70 %, warning from 70 %, danger from 90 %; clamped at 100 %,
 * where an over-limit session also tints the ring itself.
 */
export function ContextRing({
  percent,
  size = 16,
  className
}: {
  percent: number
  size?: number
  className?: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  const over = isOverContextLimit(percent)
  const c = size / 2
  const fraction = clamped / 100
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', className)}
      aria-hidden
    >
      <circle
        cx={c}
        cy={c}
        r={c - 0.75}
        fill="none"
        stroke={over ? 'var(--danger)' : 'var(--hairline-strong)'}
        strokeWidth={1.5}
      />
      {fraction > 0 && (
        <path
          d={sectorPath(c, c - 3, Math.max(fraction, 0.04))}
          fill={gaugeColor(clamped)}
          className="transition-[fill] duration-[var(--dur-slow)]"
        />
      )}
    </svg>
  )
}

/** Composer footer gauge: ring + percent, tokens in the tooltip. */
export function ContextMeter({ usage }: { usage: EngineContextUsage | undefined }) {
  if (!usage) return null
  const percent = usage.percent ?? 0
  const over = isOverContextLimit(percent)
  const label =
    usage.tokens === null
      ? `Context window ${formatTokens(usage.contextWindow)} · usage updates after the next reply`
      : over
        ? `Over the context window · ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`
        : `Context ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`
  return (
    <Tooltip content={label} side="top">
      <span
        className={cn(
          'no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-fg-3 hover:bg-hover hover:text-fg-2',
          over && 'text-danger hover:text-danger'
        )}
      >
        <ContextRing percent={percent} />
        <span className="tabular @max-[40em]/composer:hidden">
          {usage.percent === null ? '—' : contextPercentLabel(percent)}
        </span>
      </span>
    </Tooltip>
  )
}

function Row({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex h-6 items-center justify-between gap-6 text-sm">
      <span className="text-fg-3">{label}</span>
      <span className={cn('tabular', strong ? 'font-medium text-fg' : 'text-fg-2')}>{value}</span>
    </div>
  )
}

/** Why the session is over its window and what happens next (auto-compaction on or off). */
function OverLimitNote({
  agentId,
  tokens,
  window
}: {
  agentId: string
  tokens: number
  window: number
}) {
  const cwd = useAgents((s) => s.agents[agentId]?.info.cwd ?? null)
  const engine = useAgents((s) => s.agents[agentId]?.info.engine ?? 'pi')
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const autoCompaction = useEffectiveSetting('compaction.enabled', cwd, engine) !== false
  return (
    <div className="mt-3 rounded-md bg-warning-soft px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--warning-border)]">
      <div className="flex items-center gap-1.5 text-sm font-medium text-warning">
        <AlertTriangle className="size-3.5 shrink-0" />
        {formatTokens(tokens - window)} over the limit
      </div>
      <p className="mt-1 text-xs leading-relaxed text-fg-2">
        {autoCompaction
          ? 'The conversation no longer fits the model. Automatic compaction summarizes it before the next request.'
          : 'The conversation no longer fits the model and automatic compaction is off. Compact it to keep going.'}
      </p>
      <Button
        variant="secondary"
        size="xs"
        disabled={running}
        onClick={() => runAction('session.compact')}
        className="mt-2"
      >
        Compact now
      </Button>
    </div>
  )
}

/** Passive context gauge + session cost for the session header (hover breakdown of tokens) and its toolbar divider. */
export function ContextUsage({ agentId }: { agentId: string }) {
  const stats = useAgents((s) => s.agents[agentId]?.stats)
  const contextWindow = useAgents((s) => s.agents[agentId]?.model?.contextWindow)
  const started = useAgents((s) => (s.agents[agentId]?.entries.length ?? 0) > 0)
  if (!stats || !started) return null
  const usage = stats.contextUsage
  const window = usage?.contextWindow ?? contextWindow ?? 0
  const tokens = usage?.tokens ?? null
  const percent = usage?.percent ?? (tokens !== null && window ? (tokens / window) * 100 : 0)
  const over = tokens !== null && isOverContextLimit(percent)
  return (
    <>
      <HoverCard.Root openDelay={180} closeDelay={80}>
        <HoverCard.Trigger asChild>
          <span
            tabIndex={0}
            aria-label={`Context ${tokens === null ? 'unknown' : over ? 'over the limit' : contextPercentLabel(percent)}, cost ${formatCost(stats.cost)}`}
            data-context-usage
            data-over-limit={over || undefined}
            className="no-drag inline-flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-xs text-fg-3 transition-colors duration-[var(--dur-instant)] outline-none hover:text-fg-2 focus-visible:shadow-focus"
          >
            <ContextRing percent={percent} />
            {over ? (
              <Badge tone="warning">Over limit</Badge>
            ) : (
              <span className="tabular">
                {tokens === null ? '—' : contextPercentLabel(percent)}
              </span>
            )}
            <span className="h-3 w-px bg-hairline-strong" />
            <span className="tabular">{formatCost(stats.cost)}</span>
          </span>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={10}
            className={cn(floatingSurface, 'w-72 p-3')}
          >
            <div className="mb-2 text-xs font-medium text-fg-3">Context window</div>
            <div className="flex items-baseline justify-between">
              <span
                className={cn('text-lg font-semibold tabular', over ? 'text-danger' : 'text-fg')}
              >
                {tokens === null ? '—' : formatTokens(tokens)}
              </span>
              <span className="text-sm text-fg-3 tabular">of {formatTokens(window)}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-active">
              <div
                className={cn(
                  'h-full rounded-full',
                  percent >= 90 ? 'bg-danger' : percent >= 70 ? 'bg-warning' : 'bg-fg-2'
                )}
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
            {tokens === null && (
              <div className="mt-1.5 text-xs text-fg-3">Recomputed after the next response.</div>
            )}
            {over && <OverLimitNote agentId={agentId} tokens={tokens} window={window} />}
            <div className="my-3 h-px bg-hairline" />
            <div className="mb-1 text-xs font-medium text-fg-3">This session</div>
            <Row label="Input" value={formatTokens(stats.tokens.input)} />
            <Row label="Output" value={formatTokens(stats.tokens.output)} />
            <Row label="Cache read" value={formatTokens(stats.tokens.cacheRead)} />
            <Row label="Cache write" value={formatTokens(stats.tokens.cacheWrite)} />
            <Row label="Cost" value={formatCost(stats.cost)} strong />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
      <span className="mx-0.5 h-4 w-px bg-hairline" aria-hidden />
    </>
  )
}
