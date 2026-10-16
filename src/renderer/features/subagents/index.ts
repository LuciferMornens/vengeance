/**
 * Subagents feature: the host-side view of pi-subagents runs (fleet pill and popover above the composer,
 * the inspector Agents tab) and the management actions. This module is the public entry point; the inspector
 * lazy-loads `AgentsPanel` directly so the detail view stays out of the startup bundle.
 */
export { subagentActions } from './actions'
export { childSessionAgent, runTitle } from './format'
export { openSubagentDetail } from './open'
export { RunGlyph } from './parts'
export {
  useAgentsTabAlert,
  useResumedRunIds,
  useSubagentFleet,
  useSubagentRun,
  useSupervisorRequestState,
  type SubagentChildView,
  type SubagentFleet,
  type SubagentRunView,
  type SubagentTarget
} from './store'
export { FleetPill } from './FleetPill'
