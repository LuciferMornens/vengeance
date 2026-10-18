import { useMemo } from 'react'
import { Copy, FolderSearch, Layers, TriangleAlert } from 'lucide-react'
import type { SpeedState } from '@shared/api/speed'
import type { ThinkingLevel } from '@shared/engine-types'
import { bridge } from '../../lib/bridge'
import {
  formatCost,
  formatDuration,
  formatRelativeTime,
  formatTokens,
  pluralize
} from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { REVEAL_LABEL } from '../../lib/platform-copy'
import type { AgentState } from '../../store/agent-state'
import { IconButton } from '../../ui'
import { ContextRing, providerLabel, ThinkingMeter } from '../chat'
import { findSpeedOption, formatSpeedPrice, hasSpeedControl, SPEED_LABELS } from '../composer/speed'
import { useEngineCapabilities } from '../engines/registry'
import { useEffectiveLaunch } from '../launch'
import { EngineCommand } from '../launch/parts'
import { agentMessageCount, agentTitle, generatedChildName } from '../sessions/model'
import { toolActivity } from './activity'
import { KeyValue, Meter, Section, usageTone, Well } from './parts'

/** `…/folder/file.jsonl`: the informative end of a long path. */
function tailPath(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}

function sessionDuration(agent: AgentState): number | null {
  const times = agent.entries
    .map((e) => e.message.timestamp)
    .filter((t) => typeof t === 'number' && t > 0)
  if (times.length < 2) return null
  const end = agent.phase === 'running' ? Date.now() : Math.max(...times)
  return end - Math.min(...times)
}

/**
 * Session length on one tile line: whole minutes to an hour, then hours and minutes. Below 10
 * minutes the seconds come apart, so a tile too narrow for them can drop just the seconds.
 */
function tileDuration(ms: number): { value: string; seconds?: string } {
  if (ms < 60_000) return { value: formatDuration(ms) }
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return { value: `${minutes}m`, seconds: `${seconds % 60}s` }
  return { value: minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m` }
}

/** Thinking level as the composer names it. */
function thinkingLabel(level: ThinkingLevel): string {
  return level === 'xhigh' ? 'Extra high' : level.charAt(0).toUpperCase() + level.slice(1)
}

/** `Fast · 2× price` (just the label at standard speed), with an `Ultrafast requested` note when the model runs another speed. */
function speedSummary(speed: SpeedState): { value: string; note?: string } {
  if (speed.options.length === 0) return { value: 'Unavailable' }
  const price = formatSpeedPrice(findSpeedOption(speed, speed.effective))
  const label = SPEED_LABELS[speed.effective]
  return {
    value: price ? `${label} \u00b7 ${price}` : label,
    note:
      speed.requested === speed.effective ? undefined : `${SPEED_LABELS[speed.requested]} requested`
  }
}

function TokenTile({ label, value, total }: { label: string; value: number; total: number }) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-fg-3">{label}</span>
        <span className="tabular text-ui font-medium text-fg">{formatTokens(value)}</span>
      </div>
      <Meter value={value} max={total} tone="var(--fg-3)" className="h-1" />
    </div>
  )
}

const TRUST_LABEL = { true: 'Trusted', false: 'Not trusted', null: 'Engine decides' } as const

/** Read-only engine launch configuration: project trust, the engine command (collapsed), extra environment, bridge. */
function EngineSection({ agent }: { agent: AgentState }) {
  const launch = useEffectiveLaunch(agent.id)
  const capabilities = useEngineCapabilities(agent.info.engine)
  if (!launch) return null
  return (
    <Section title="Engine">
      <Well className="divide-y divide-hairline-soft">
        {capabilities?.trust && (
          <KeyValue label="Project trust">
            {TRUST_LABEL[String(launch.trust) as keyof typeof TRUST_LABEL]}
          </KeyValue>
        )}
        {agent.info.engine === 'pi' && (
          <KeyValue label="Desktop bridge">
            {bridge.available(agent.id) ? 'Loaded' : 'Not loaded'}
          </KeyValue>
        )}
        <EngineCommand
          args={launch.args}
          envKeys={launch.envKeys}
          engine={launch.engine}
          configuration={launch.configuration}
          className="py-1 pr-1.5 pl-3"
        />
      </Well>
    </Section>
  )
}

export function Overview({ agent }: { agent: AgentState }) {
  const stats = agent.stats
  const usage = stats?.contextUsage
  const percent = usage?.percent ?? null
  const tokens = stats?.tokens
  const { entries, tools } = agent
  // Committed calls only: the streamed message's tool calls count once they land (no recompute per token).
  const activity = useMemo(
    () => toolActivity({ entries, streaming: null, tools }),
    [entries, tools]
  )
  const toolErrors = activity.filter((a) => a.isError).length
  const duration = sessionDuration(agent)
  const sessionFile = agent.session?.sessionFile ?? agent.info.sessionFile
  const model = agent.model
  const speed = hasSpeedControl(agent.speed) ? speedSummary(agent.speed) : null
  const tokenTotal = tokens
    ? Math.max(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, 1)
    : 1

  return (
    <div className="flex flex-col gap-5 px-4 pt-3 pb-6">
      <Well className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <ContextRing percent={percent ?? 0} size={34} />
          <div className="min-w-0 flex-1">
            <div className="tabular heading text-xl leading-none font-semibold text-fg">
              {percent === null ? '—' : `${Math.min(100, Math.round(percent))}%`}
            </div>
            {/* The numbers always show; the words drop where they would not fit beside them. */}
            <div className="tabular @container mt-1.5 flex gap-1 text-xs text-fg-3">
              <span className="truncate @max-[11em]:hidden">of context ·</span>
              <span className="shrink-0">
                {formatTokens(usage?.tokens)} /{' '}
                {formatTokens(usage?.contextWindow ?? model?.contextWindow)}
              </span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="tabular heading text-xl leading-none font-semibold text-fg">
              {formatCost(stats?.cost)}
            </div>
            <div className="mt-1.5 text-xs text-fg-3">session cost</div>
          </div>
        </div>
        <Meter
          value={usage?.tokens ?? 0}
          max={usage?.contextWindow ?? model?.contextWindow ?? 1}
          tone={usageTone(percent ?? 0)}
        />
        {percent !== null && percent > 100 && (
          <div className="-mt-1 flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert className="size-3.5" />
            Over the limit · compaction pending
          </div>
        )}
      </Well>

      <Section title="Model">
        <Well className="divide-y divide-hairline-soft">
          <KeyValue label="Model">{model ? model.name : '—'}</KeyValue>
          <KeyValue label="Provider">{model ? providerLabel(model.provider) : '—'}</KeyValue>
          <KeyValue label="Thinking">
            {agent.thinkingLevel ? (
              <span className="inline-flex items-center gap-2">
                <ThinkingMeter level={agent.thinkingLevel} className="text-fg-3" />
                {thinkingLabel(agent.thinkingLevel)}
              </span>
            ) : (
              '—'
            )}
          </KeyValue>
          {speed && (
            <KeyValue label="Speed" note={speed.note}>
              {speed.value}
            </KeyValue>
          )}
          {model && (
            <KeyValue label="Pricing">{`$${model.cost.input} in · $${model.cost.output} out / M`}</KeyValue>
          )}
        </Well>
      </Section>

      <Section
        title="Tokens"
        aside={
          <span className="tabular text-xs text-fg-3">{formatTokens(tokens?.total)} total</span>
        }
      >
        <Well className="grid grid-cols-2 divide-x divide-hairline-soft [&>*:nth-child(n+3)]:border-t [&>*:nth-child(n+3)]:border-hairline-soft">
          <TokenTile label="Input" value={tokens?.input ?? 0} total={tokenTotal} />
          <TokenTile label="Output" value={tokens?.output ?? 0} total={tokenTotal} />
          <TokenTile label="Cache read" value={tokens?.cacheRead ?? 0} total={tokenTotal} />
          <TokenTile label="Cache write" value={tokens?.cacheWrite ?? 0} total={tokenTotal} />
        </Well>
      </Section>

      <Section title="Activity">
        <Well className="grid grid-cols-3 divide-x divide-hairline-soft">
          {[
            {
              label: 'Messages',
              value: String(agentMessageCount(agent)),
              hint: stats ? `${stats.userMessages} from you` : ''
            },
            {
              label: 'Tool calls',
              value: String(activity.length),
              hint: toolErrors ? pluralize(toolErrors, 'error') : 'no errors'
            },
            {
              label: 'Duration',
              ...(duration === null ? { value: '—' } : tileDuration(duration)),
              hint: agent.phase === 'running' ? 'running' : 'active time'
            }
          ].map((tile) => (
            <div key={tile.label} className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
              <span className="text-2xs text-fg-3">{tile.label}</span>
              {/* One line: seconds that do not fit ("59s" of "9m 59s") wrap onto a clipped second line. */}
              <span className="tabular heading flex h-[1lh] flex-wrap gap-x-[0.25em] overflow-hidden text-lg leading-tight font-semibold text-fg">
                <span className="min-w-0 truncate">{tile.value}</span>
                {tile.seconds && <span>{tile.seconds}</span>}
              </span>
              <span
                className={
                  toolErrors && tile.label === 'Tool calls'
                    ? 'text-2xs text-danger'
                    : 'text-2xs text-fg-3'
                }
              >
                {tile.hint}
              </span>
            </div>
          ))}
        </Well>
      </Section>

      {agent.lastCompaction && (
        <Section title="Compaction">
          <Well className="flex items-start gap-3 p-3">
            <Layers className="mt-0.5 size-4 shrink-0 text-fg-3" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="text-fg">
                {agent.lastCompaction.aborted
                  ? 'Compaction was cancelled'
                  : agent.lastCompaction.errorMessage
                    ? 'Compaction failed'
                    : `Compacted ${formatTokens(agent.lastCompaction.result?.tokensBefore)} → ${formatTokens(agent.lastCompaction.result?.estimatedTokensAfter)}`}
              </div>
              <div className="text-xs text-fg-3">
                {agent.lastCompaction.reason} · {formatRelativeTime(agent.lastCompaction.at)}
              </div>
            </div>
          </Well>
        </Section>
      )}

      <EngineSection agent={agent} />

      <Section title="Session">
        <Well className="divide-y divide-hairline-soft">
          <KeyValue label="Name">
            {agent.sessionName && !generatedChildName(agent.sessionName) ? (
              agent.sessionName
            ) : (
              <span className="text-fg-3" title={generatedChildName(agent.sessionName)}>
                {agentTitle(agent)}
              </span>
            )}
          </KeyValue>
          <KeyValue label="ID" mono>
            {agent.session?.sessionId?.slice(0, 8) ?? '—'}
          </KeyValue>
          <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
            <span className="shrink-0 text-sm text-fg-3">File</span>
            <span
              className="selectable min-w-0 flex-1 truncate text-right font-mono text-2xs text-fg-2"
              title={sessionFile}
            >
              {sessionFile ? tailPath(sessionFile) : 'Not saved (ephemeral)'}
            </span>
            {sessionFile && (
              <>
                <IconButton
                  label="Copy path"
                  size="xs"
                  onClick={() => void navigator.clipboard.writeText(sessionFile)}
                >
                  <Copy />
                </IconButton>
                <IconButton
                  label={REVEAL_LABEL}
                  size="xs"
                  onClick={() => void invoke('sys:reveal', sessionFile)}
                >
                  <FolderSearch />
                </IconButton>
              </>
            )}
          </div>
        </Well>
      </Section>
    </div>
  )
}
