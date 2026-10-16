/**
 * Tools feature: one 28px row per tool call. Each renderer module registers itself via registerToolRenderer();
 * unknown / extension / MCP tools fall back to the generic row.
 *
 * For other features: `useToolsExpanded()` / `setToolsExpanded()` / `toggleToolsExpanded()` are the app-level
 * "expand all tool output" switch (Ctrl+O, pi's `app.tools.expand`); every row follows it until toggled.
 * `TodoDock({ agentId })` is the session's todo list from its todo tool results, mounted by the composer.
 */
import './tools.css'
import './renderers/generic'
import './renderers/bash'
import './renderers/read'
import './renderers/edit'
import './renderers/write'
import './renderers/search'
import './renderers/todo'
import './renderers/ask-user'
import './renderers/subagent'
import './renderers/agent-tools'
import './renderers/web'
import './renderers/lens'
import './renderers/history'
import './renderers/codemode'
import './renderers/mcp'
import { memo, useMemo } from 'react'
import type { ToolCall } from '@shared/engine-types'
import { useAgents } from '../../store/agents'
import { preloadDiffModule } from './diff-lazy'
import { ToolCallContext } from './disclosure'
import { getToolRenderer } from './registry'

export { registerToolRenderer, getToolRenderer, type ToolRendererProps, type ToolRenderer } from './registry'
export { Console } from './Console'
export { TodoDock } from './TodoDock'
export { ExitBadge, PromptIcon } from './renderers/bash'
export { isPinnedRun } from './renderers/subagent'
export { DetailSection, StatusGlyph, Elapsed, RowDetail, ToolGroupContext, ToolRow } from './ToolRow'
export { toolPhase, isActive, isBenignFailure, humanizeToolName, type ToolPhase } from './tool-utils'
export { useHasSupervisorRequest, useUserAnswerRelayIds, useUserSupervisorReply } from './supervisor-exchange'
export { useDisclosure, useDisclosureChoice, useToolsExpanded, setToolsExpanded, toggleToolsExpanded } from './disclosure'

preloadDiffModule()

/** Render one tool call (looks up the renderer registered for its tool name). */
export const ToolCallView = memo(function ToolCallView({ agentId, call }: { agentId: string; call: ToolCall }) {
  const execution = useAgents((s) => s.agents[agentId]?.tools[call.id])
  const scope = useMemo(() => ({ call, execution }), [call, execution])
  const Renderer = getToolRenderer(call.name)
  return (
    <ToolCallContext.Provider value={scope}>
      <Renderer agentId={agentId} call={call} execution={execution} />
    </ToolCallContext.Provider>
  )
})
