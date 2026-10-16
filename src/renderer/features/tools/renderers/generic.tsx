import { cn } from '../../../lib/cn'
import { stripAnsi } from '../../../lib/ansi'
import type { ToolExecution } from '../../../store/agent-state'
import { useAgents } from '../../../store/agents'
import { CodeView } from '../../../ui/CodeView'
import { Markdown } from '../../../ui/Markdown'
import { fitsJsonTree, JsonTree, parseJsonData, splitTrailingJson } from '../JsonTree'
import { LetterTile } from '../LetterTile'
import { setFallbackToolRenderer, type ToolRendererProps } from '../registry'
import { DetailSection, MonoSubject, RowDetail, ToolRow } from '../ToolRow'
import { firstLine, humanizeToolName, isActive, isRecord, mcpServer, payloadImages, payloadText, resultPayload, toolPhase } from '../tool-utils'

/** Subject argument keys, in preference order; all but `query` and `name` hold code-like values (shown mono). */
const PRIMARY_KEYS = ['path', 'file', 'filePath', 'command', 'pattern', 'query', 'url', 'name', 'action', 'id']
const PROSE_KEYS = new Set(['query', 'name'])

export function primaryArg(args: Record<string, unknown>): { text: string; mono: boolean } {
  for (const key of PRIMARY_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value) return { text: value.split('\n')[0]!, mono: !PROSE_KEYS.has(key) }
  }
  const first = Object.values(args).find((v): v is string => typeof v === 'string' && v.length < 200)
  // Any other string: a sentence (issue title, question) reads as text, a single token as code.
  return { text: first?.split('\n')[0] ?? '', mono: !!first && !/\s/.test(first.trim()) }
}

/** The primary argument as a row subject (mono for code-like values). */
export function PrimaryArgSubject({ args }: { args: Record<string, unknown> }) {
  const arg = primaryArg(args)
  if (!arg.text) return null
  return arg.mono ? <MonoSubject>{arg.text}</MonoSubject> : <span className="min-w-0 truncate">{arg.text}</span>
}

const MARKDOWN_HINT = /(^|\n)(#{1,6} |[-*] |\d+\. |> |```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`/

/** Key/value view of tool arguments (never a raw JSON wall). */
export function ArgsGrid({ args }: { args: Record<string, unknown> }) {
  if (Object.keys(args).length === 0) return null
  return fitsJsonTree(args) ? (
    <JsonTree value={args} />
  ) : (
    <div className="bg-[var(--code-bg)] px-3.5 py-2.5">
      <CodeView code={JSON.stringify(args, null, 2)} lang="json" />
    </div>
  )
}

function TextResult({ text, error }: { text: string; error?: boolean }) {
  return !error && MARKDOWN_HINT.test(text) ? (
    <div className="px-3.5 py-3">
      <Markdown text={text.slice(0, 20_000)} size="compact" />
    </div>
  ) : (
    <pre
      className={cn(
        'selectable px-3.5 py-2.5 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap',
        error ? 'bg-danger-soft text-danger' : 'text-fg-2'
      )}
    >
      {text.slice(0, 20_000)}
    </pre>
  )
}

/** Drops result keys that only echo an argument with the same value (the tree right above already shows it). */
function withoutEcho(data: Record<string, unknown> | unknown[], echo?: Record<string, unknown>): Record<string, unknown> | unknown[] {
  if (!echo || Array.isArray(data)) return data
  const kept = Object.entries(data).filter(([key, value]) => !(key in echo) || JSON.stringify(echo[key]) !== JSON.stringify(value))
  return kept.length > 0 ? Object.fromEntries(kept) : data
}

/** JSON result: the structured tree when it fits, else highlighted JSON (the raw source is in the Raw view). */
function JsonResult({ data: full, echo }: { data: Record<string, unknown> | unknown[]; echo?: Record<string, unknown> }) {
  const data = withoutEcho(full, echo)
  if (!fitsJsonTree(data)) {
    return (
      <div className="bg-[var(--code-bg)] px-3.5 py-2.5">
        <CodeView code={JSON.stringify(data, null, 2)} lang="json" />
      </div>
    )
  }
  return <JsonTree value={data} />
}

/**
 * Tool result as a structured JSON tree / markdown / plain text, plus images. Text that ends in JSON (script
 * output) shows the text, then the tree.
 */
export function ResultView({
  text,
  images,
  error,
  echo
}: {
  text: string
  images: Array<{ data: string; mimeType: string }>
  error?: boolean
  /** The call's arguments: result keys repeating them verbatim are hidden. */
  echo?: Record<string, unknown>
}) {
  const clean = stripAnsi(text).trim()
  const json = clean && !error ? parseJsonData(clean) : null
  const trailing = clean && !error && !json ? splitTrailingJson(clean) : null
  return (
    <>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3.5 py-3">
          {images.map((img, i) => (
            <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" className="max-h-56 rounded-md shadow-[0_0_0_1px_var(--hairline)]" />
          ))}
        </div>
      )}
      {json ? (
        <JsonResult data={json} echo={echo} />
      ) : trailing ? (
        <>
          <TextResult text={trailing.prose} />
          <div className="border-t border-hairline-soft">
            <JsonResult data={trailing.data} echo={echo} />
          </div>
        </>
      ) : (
        clean && <TextResult text={clean} error={error} />
      )}
    </>
  )
}

/** Arguments, then the result: the detail of any tool without a dedicated renderer. */
export function GenericDetail({ args, execution, failed }: { args: Record<string, unknown>; execution: ToolExecution | undefined; failed: boolean }) {
  const payload = resultPayload(execution)
  const text = payloadText(payload)
  const images = payloadImages(payload)
  const hasArgs = Object.keys(args).length > 0
  return (
    <RowDetail copy={text}>
      {hasArgs && <DetailSection label="Input">{<ArgsGrid args={args} />}</DetailSection>}
      {(text || images.length > 0) && (
        <DetailSection label={failed ? 'Error' : 'Result'}>
          <ResultView text={text} images={images} error={failed} echo={args} />
        </DetailSection>
      )}
    </RowDetail>
  )
}

/** Logo stand-in for an unknown tool: its MCP server, else the family prefix of `family_action` names. */
function toolTileName(name: string, server: string | null): string | null {
  if (server) return server
  const parts = name.split(/__|_/).filter(Boolean)
  return parts.length >= 2 ? parts[0]! : null
}

/**
 * Any tool without a dedicated renderer (extension and MCP tools). MCP calls read as "<Server> · <Tool>" with
 * the server's letter tile; others as the humanized tool name.
 */
function GenericToolRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const server = mcpServer(call.name, execution)
  const details = resultPayload(execution)?.details
  const mcpTool = server && isRecord(details) && typeof details.tool === 'string' ? details.tool : null
  const tile = toolTileName(call.name, server)
  const name = humanizeToolName(mcpTool ?? call.name)
  const args = isRecord(call.arguments) ? call.arguments : {}
  const failed = phase === 'error'
  return (
    <ToolRow
      icon={tile ? <LetterTile name={tile} size="sm" /> : undefined}
      verb={server ? humanizeToolName(server) : isActive(phase) ? `Using ${name}` : name}
      subject={
        <>
          {server && <span className="shrink-0 text-fg">{name}</span>}
          <PrimaryArgSubject args={args} />
        </>
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(payloadText(resultPayload(execution))) || 'Failed' : undefined}
      sublineTone="danger"
      detail={<GenericDetail args={args} execution={execution} failed={failed} />}
    />
  )
}

setFallbackToolRenderer(GenericToolRow)
