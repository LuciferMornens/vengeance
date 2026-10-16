import { useMemo } from 'react'
import { useAgents } from '../../../store/agents'
import { Badge } from '../../../ui'
import { LetterTile } from '../LetterTile'
import { McpServerBadge } from '../McpBadge'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailEmpty, DetailNote, MonoSubject, RowDetail, ShowMore, ToolRow, usePreviewExpanded } from '../ToolRow'
import { firstLine, humanizeToolName, isActive, isRecord, mcpServer, payloadImages, payloadText, plural, records, resultPayload, str, strings, toolPhase } from '../tool-utils'
import { ResultView } from './generic'

const LIST_LIMIT = 12

/** Tools `tool_search` loaded: `details.loaded` names, descriptions from the "- name: description" text lines. */
function loadedTools(text: string, loaded: string[]): Array<{ name: string; description: string }> {
  const described = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^- ([^:]+): (.*)$/.exec(line)
    if (match) described.set(match[1]!.trim(), match[2]!.trim())
  }
  const names = loaded.length > 0 ? loaded : [...described.keys()]
  return names.map((name) => ({ name, description: described.get(name) ?? '' }))
}

/** pi's `tool_search`: BM25 over deferred tools (MCP, codemode exposure); matches are loaded for the next model call. */
function ToolSearchRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const payload = resultPayload(execution)
  const text = payloadText(payload)
  const loaded = isRecord(payload?.details) ? strings(payload.details.loaded) : []
  const tools = loadedTools(text, loaded)
  const query = str(call.arguments.query) ?? ''
  const failed = phase === 'error'
  return (
    <ToolRow
      verb={isActive(phase) ? 'Searching tools' : 'Searched tools'}
      subject={<span className="min-w-0 truncate">“{query || '\u2026'}”</span>}
      meta={phase === 'done' ? <span>{tools.length === 0 ? 'no matches' : `${tools.length} loaded`}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'Tool search failed' : undefined}
      sublineTone="danger"
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={text}>
            {failed ? (
              <DetailNote tone="danger">{text || 'Tool search failed'}</DetailNote>
            ) : tools.length === 0 ? (
              <DetailEmpty>No matching tools found.</DetailEmpty>
            ) : (
              <div className="py-1.5">
                <div className="px-3.5 pb-1 text-xs text-fg-3">Available from the next model call</div>
                {tools.map((tool) => {
                  const server = mcpServer(tool.name)
                  return (
                    <div key={tool.name} className="flex min-w-0 items-start gap-2.5 px-3.5 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-fg">{humanizeToolName(tool.name)}</span>
                          <span className="min-w-0 truncate font-mono text-[11.5px] text-fg-3">{tool.name}</span>
                        </span>
                        {tool.description && <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-3">{tool.description}</span>}
                      </span>
                      {server && <McpServerBadge server={server} />}
                    </div>
                  )
                })}
              </div>
            )}
          </RowDetail>
        )
      }
    />
  )
}

interface ResourceRow {
  server: string
  /** `uri` for resources, `uriTemplate` for templates. */
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/** Listing JSON (Codex shape): `{ server?, resources|resourceTemplates: [{ server, ... }], nextCursor? }`. */
function parseListing(text: string, key: 'resources' | 'resourceTemplates'): { rows: ResourceRow[]; more: boolean } | null {
  try {
    const data: unknown = JSON.parse(text)
    if (!isRecord(data) || !Array.isArray(data[key])) return null
    const rows = records(data[key]).map((r) => ({
      server: str(r.server) ?? str(data.server) ?? '',
      uri: str(r.uri) ?? str(r.uriTemplate) ?? '',
      name: str(r.title) ?? str(r.name) ?? '',
      description: str(r.description),
      mimeType: str(r.mimeType)
    }))
    return { rows, more: typeof data.nextCursor === 'string' }
  } catch {
    return null
  }
}

function ResourceList({ rows }: { rows: ResourceRow[] }) {
  const [all, setAll] = usePreviewExpanded('resources')
  const shown = all ? rows : rows.slice(0, LIST_LIMIT)
  const servers = new Set(rows.map((r) => r.server))
  return (
    <>
      <div className="py-1.5">
        {shown.map((row, i) => (
          <div key={`${row.server}:${row.uri}:${i}`} className="flex min-w-0 items-start gap-2.5 px-3.5 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{row.name || row.uri}</span>
              <span className="selectable block truncate font-mono text-[11.5px] text-fg-3">{row.uri}</span>
              {row.description && <span className="mt-0.5 line-clamp-2 block text-xs text-fg-3">{row.description}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
              {row.mimeType && <Badge>{row.mimeType}</Badge>}
              {servers.size > 1 && row.server && <McpServerBadge server={row.server} />}
            </span>
          </div>
        ))}
      </div>
      {rows.length > LIST_LIMIT && <ShowMore expanded={all} onToggle={() => setAll(!all)} hidden={rows.length - LIST_LIMIT} unit="resources" />}
    </>
  )
}

/** pi's MCP resource tools: `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` (dist/extensions/mcp/resources.d.ts). */
function McpResourceRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const payload = resultPayload(execution)
  const text = payloadText(payload)
  const images = payloadImages(payload)
  const reading = call.name === 'read_mcp_resource'
  const templates = call.name === 'list_mcp_resource_templates'
  const server = str(call.arguments.server) ?? (isRecord(payload?.details) ? str(payload.details.server) : undefined)
  const listing = useMemo(() => (reading || phase !== 'done' ? null : parseListing(text, templates ? 'resourceTemplates' : 'resources')), [reading, phase, text, templates])
  const uri = str(call.arguments.uri)
  const count = listing?.rows.length ?? 0
  const unit = templates ? 'template' : 'resource'
  const active = isActive(phase)
  const failed = phase === 'error'
  return (
    <ToolRow
      icon={server ? <LetterTile name={server} size="sm" /> : undefined}
      verb={reading ? (active ? 'Reading resource' : 'Read resource') : active ? `Listing ${unit}s` : `Listed ${unit}s`}
      subject={
        <>
          {server && <span className="shrink-0 text-fg">{humanizeToolName(server)}</span>}
          {uri && <MonoSubject>{uri}</MonoSubject>}
        </>
      }
      meta={listing ? <span>{count === 0 ? 'none' : `${plural(count, unit)}${listing.more ? '+' : ''}`}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'The MCP server returned an error' : undefined}
      sublineTone="danger"
      detail={
        active ? undefined : (
          <RowDetail copy={text}>
            {failed ? (
              <DetailNote tone="danger">{text || 'The MCP server returned an error'}</DetailNote>
            ) : listing ? (
              count === 0 ? <DetailEmpty>{templates ? 'No resource templates.' : 'No resources.'}</DetailEmpty> : <ResourceList rows={listing.rows} />
            ) : (
              (text || images.length > 0) && <ResultView text={text} images={images} />
            )}
          </RowDetail>
        )
      }
    />
  )
}

registerToolRenderer('tool_search', ToolSearchRow)
registerToolRenderer(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'], McpResourceRow)
