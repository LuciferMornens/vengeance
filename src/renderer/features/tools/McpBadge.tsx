import { Plug } from 'lucide-react'
import { Badge } from '../../ui'

/** Neutral badge naming the MCP server a tool call went to. */
export function McpServerBadge({ server }: { server: string }) {
  return (
    <Badge title={`MCP server: ${server}`} className="max-w-[160px] gap-1 font-medium">
      <Plug className="size-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
      <span className="truncate">{server}</span>
    </Badge>
  )
}
