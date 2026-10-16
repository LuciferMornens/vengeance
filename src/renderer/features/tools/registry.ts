import type { ComponentType } from 'react'
import type { ToolCall } from '@shared/engine-types'
import type { ToolExecution } from '../../store/agent-state'

/** Props every tool renderer receives. */
export interface ToolRendererProps {
  agentId: string
  /** The tool call block from the assistant message (arguments may be partial while streaming). */
  call: ToolCall
  /** Execution state keyed by toolCallId (undefined only for malformed history). */
  execution: ToolExecution | undefined
}

export type ToolRenderer = ComponentType<ToolRendererProps>

const renderers = new Map<string, ToolRenderer>()
let fallback: ToolRenderer | null = null

/** Register a renderer for one or more tool names (e.g. 'bash', or ['grep', 'find']). Later registrations win. */
export function registerToolRenderer(toolNames: string | string[], renderer: ToolRenderer): void {
  for (const name of Array.isArray(toolNames) ? toolNames : [toolNames]) renderers.set(name, renderer)
}

/** Renderer used for tools without a specific registration (unknown/extension/MCP tools). */
export function setFallbackToolRenderer(renderer: ToolRenderer): void {
  fallback = renderer
}

export function getToolRenderer(toolName: string): ToolRenderer {
  const renderer = renderers.get(toolName) ?? fallback
  if (!renderer) throw new Error('No fallback tool renderer registered')
  return renderer
}

export function hasToolRenderer(toolName: string): boolean {
  return renderers.has(toolName)
}
