import { useMemo } from 'react'
import type { ToolResultPayload } from '@shared/engine-types'
import { cn } from '../../../lib/cn'
import { useAgents } from '../../../store/agents'
import { Markdown, openExternal } from '../../../ui/Markdown'
import { LetterTile } from '../LetterTile'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailNote, RowDetail, ToolRow } from '../ToolRow'
import { ResultView } from './generic'
import { detailsOf, firstLine, isActive, isRecord, num, payloadText, plural, records, resultPayload, str, strings, toolPhase } from '../tool-utils'

interface Source {
  title: string
  url: string
  snippet?: string
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function queriesOf(args: Record<string, unknown>): string[] {
  const list = strings(args.queries)
  if (list.length > 0) return list
  const query = str(args.query)
  return query ? [query] : []
}

/** Sources from structured content, curated details, or markdown links in the text (in that order). */
function sourcesOf(payload: ToolResultPayload | undefined): { sources: Source[]; answer?: string } {
  const structured = payload?.structuredContent
  if (isRecord(structured)) {
    const queries = records(structured.queries)
    const sources = queries.flatMap((q) => records(q.results).map((r) => ({ title: str(r.title) ?? '', url: str(r.url) ?? '', snippet: str(r.snippet) })))
    const answer = queries.map((q) => str(q.answer)).find(Boolean)
    if (sources.length > 0 || answer) return { sources: sources.filter((s) => s.url), answer }
  }
  const details = isRecord(payload?.details) ? payload.details : undefined
  const curated = records(details?.curatedQueries)
  if (curated.length > 0) {
    return { sources: curated.flatMap((q) => records(q.sources).map((s) => ({ title: str(s.title) ?? '', url: str(s.url) ?? '' }))).filter((s) => s.url) }
  }
  const text = payloadText(payload)
  const seen = new Set<string>()
  const sources: Source[] = []
  for (const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (seen.has(m[2]!)) continue
    seen.add(m[2]!)
    sources.push({ title: m[1]!, url: m[2]! })
  }
  return { sources }
}

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <div className="py-1">
      {sources.slice(0, 12).map((s) => (
        <button
          key={s.url}
          type="button"
          onClick={() => openExternal(s.url)}
          title={s.url}
          className="flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-hover"
        >
          <LetterTile name={domainOf(s.url)} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-fg">{s.title || s.url}</span>
            <span className="block truncate text-xs text-fg-3">{domainOf(s.url)}</span>
            {s.snippet && <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-3">{s.snippet}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="px-3.5 py-3">
      <Markdown text={text.slice(0, 20_000)} size="compact" />
    </div>
  )
}

function WebSearchRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const queries = queriesOf(call.arguments)
  const { sources, answer } = useMemo(() => sourcesOf(execution?.result), [execution?.result])
  const partial = isRecord(execution?.partialResult?.details) ? execution.partialResult.details : undefined
  const current = str(partial?.currentQuery)
  const total = num(detailsOf(execution)?.totalResults) ?? sources.length
  const text = payloadText(resultPayload(execution))
  const failed = phase === 'error'
  return (
    <ToolRow
      verb={isActive(phase) ? 'Searching the web' : 'Searched the web'}
      subject={<span className="min-w-0 truncate">{queries.length > 1 ? plural(queries.length, 'query', 'queries') : `“${queries[0] ?? '\u2026'}”`}</span>}
      meta={phase === 'done' && total > 0 ? <span>{plural(total, 'result')}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'Search failed' : isActive(phase) && current && queries.length > 1 ? `“${current}”` : undefined}
      sublineTone={failed ? 'danger' : 'neutral'}
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={text}>
            {failed ? (
              <DetailNote tone="danger">{text || 'Search failed'}</DetailNote>
            ) : (
              <>
                {queries.length > 1 && (
                  <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
                    {queries.map((q) => (
                      <span key={q} className="rounded-full px-2.5 py-0.5 text-xs text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
                        {q}
                      </span>
                    ))}
                  </div>
                )}
                {answer && <MarkdownBlock text={answer} />}
                {sources.length > 0 ? <SourceList sources={sources} /> : text && !answer && <MarkdownBlock text={text} />}
              </>
            )}
          </RowDetail>
        )
      }
    />
  )
}

/** First URL's host with a letter tile, `+N` for the rest. */
function UrlSubject({ urls }: { urls: string[] }) {
  const first = urls[0]
  if (!first) return null
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={first}>
      <LetterTile name={domainOf(first)} size="sm" />
      <span className="min-w-0 truncate">{domainOf(first)}</span>
      {urls.length > 1 && <span className="shrink-0 text-fg-3">+{urls.length - 1}</span>}
    </span>
  )
}

function FetchRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const listed = strings(call.arguments.urls)
  const single = str(call.arguments.url)
  const urls = listed.length > 0 ? listed : single ? [single] : []
  const details = detailsOf(execution)
  const urlCount = num(details?.urlCount) ?? urls.length
  const successful = num(details?.successful)
  const structured = isRecord(execution?.result?.structuredContent) ? records(execution.result.structuredContent.urls) : []
  const text = payloadText(resultPayload(execution))
  const failed = phase === 'error'
  return (
    <ToolRow
      verb={isActive(phase) ? 'Fetching' : 'Fetched'}
      subject={<UrlSubject urls={urls} />}
      meta={
        phase === 'done' && successful !== undefined && urlCount > 1 ? (
          <span className={cn(successful < urlCount && 'text-warning')}>
            {successful} of {urlCount} ok
          </span>
        ) : null
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'Fetch failed' : undefined}
      sublineTone="danger"
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={text}>
            {failed ? (
              <DetailNote tone="danger">{text || 'Fetch failed'}</DetailNote>
            ) : structured.length > 0 ? (
              <div className="divide-y divide-hairline-soft">
                {structured.map((page, i) => (
                  <div key={i} className="px-3.5 py-3">
                    <div className="mb-1.5 truncate text-sm font-medium text-fg">{str(page.title) ?? str(page.url)}</div>
                    <Markdown text={(str(page.content) ?? str(page.error) ?? '').slice(0, 6000)} size="compact" />
                  </div>
                ))}
              </div>
            ) : (
              text && <MarkdownBlock text={text} />
            )}
          </RowDetail>
        )
      }
    />
  )
}

/** `12k chars` for a page excerpt. */
function charCount(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}k chars` : `${chars} chars`
}

function SearchContentRow({ agentId, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const details = detailsOf(execution)
  const url = str(details?.url)
  const title = str(details?.title)
  const chars = num(details?.returnedChars)
  const text = payloadText(resultPayload(execution))
  const failed = phase === 'error'
  return (
    <ToolRow
      verb={isActive(phase) ? 'Reading' : 'Read'}
      subject={
        title || url ? (
          <span className="flex min-w-0 items-center gap-1.5" title={url}>
            {url && <LetterTile name={domainOf(url)} size="sm" />}
            <span className="min-w-0 truncate">{title ?? domainOf(url!)}</span>
          </span>
        ) : (
          <span className="text-fg-3">saved search results</span>
        )
      }
      meta={chars !== undefined ? <span>{charCount(chars)}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'Read failed' : undefined}
      sublineTone="danger"
      detail={isActive(phase) ? undefined : <RowDetail copy={text}>{failed ? <DetailNote tone="danger">{text}</DetailNote> : text && <MarkdownBlock text={text} />}</RowDetail>}
    />
  )
}

const CLAIM_STATUS: Record<string, { label: string; warning: boolean }> = {
  supported: { label: 'supported', warning: false },
  contradicted: { label: 'contradicted', warning: true },
  unclear: { label: 'unclear', warning: true },
  'missing-evidence': { label: 'missing evidence', warning: true }
}

function SourceCheckRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const details = detailsOf(execution)
  const artifact = isRecord(details?.artifact) ? details.artifact : undefined
  const status = CLAIM_STATUS[str(records(artifact?.claims)[0]?.status) ?? '']
  const sources = num(details?.sourceCount)
  const text = payloadText(resultPayload(execution))
  const failed = phase === 'error'
  return (
    <ToolRow
      verb={isActive(phase) ? 'Checking a claim' : 'Checked a claim'}
      subject={<span className="min-w-0 truncate">{str(call.arguments.claim) ?? ''}</span>}
      meta={
        phase === 'done' ? (
          <>
            {sources !== undefined && <span>{plural(sources, 'source')}</span>}
            {status && <span className={cn(status.warning && 'text-warning')}>{status.label}</span>}
          </>
        ) : null
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'Check failed' : undefined}
      sublineTone="danger"
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={text}>{failed ? <DetailNote tone="danger">{text}</DetailNote> : <ResultView text={text} images={[]} />}</RowDetail>
        )
      }
    />
  )
}

registerToolRenderer(['web_search', 'websearch', 'WebSearch'], WebSearchRow)
registerToolRenderer(['fetch_content', 'web_fetch', 'WebFetch', 'fetch'], FetchRow)
registerToolRenderer('get_search_content', SearchContentRow)
registerToolRenderer('source_check', SourceCheckRow)
