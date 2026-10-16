import { Bot } from 'lucide-react'
import type { AgentState } from '../../store/agent-state'
import { Section, TabEmpty } from '../inspector/parts'
import { AgentDetail } from './AgentDetail'
import { useNow } from './format'
import { openSubagentDetail } from './open'
import { AgentRow, ChildRows, runMenu } from './parts'
import { isUnseenFailure, useSubagentFleet, useSubagentUi, type SubagentRunView } from './store'

/** Inspector "Agents" tab: every run of the session (active, then finished), or the selected run's detail. */
export function AgentsPanel({ agent }: { agent: AgentState }) {
  const selection = useSubagentUi((s) => s.selection)
  if (selection && selection.agentId === agent.id) {
    return <AgentDetail key={selection.runId} agentId={agent.id} runId={selection.runId} childId={selection.childId} intent={selection.intent} />
  }
  return <AgentList agent={agent} />
}

function AgentList({ agent }: { agent: AgentState }) {
  const { active, all } = useSubagentFleet(agent.id)
  const finished = all.slice(active.length)
  const now = useNow(active.length > 0)

  if (all.length === 0) {
    return (
      <TabEmpty icon={<Bot />} title="No agents yet">
        Subagents the Engine starts in this session appear here while they work and after they finish.
      </TabEmpty>
    )
  }

  const row = (view: SubagentRunView) => (
    <div key={view.runId}>
      <AgentRow
        view={view}
        now={now}
        unseen={isUnseenFailure(view, agent.subagents)}
        onOpen={() => openSubagentDetail(agent.id, view.runId)}
        menu={runMenu(agent.id, view, (intent) => openSubagentDetail(agent.id, view.runId, undefined, intent))}
      />
      {view.kind === 'workflow' && view.children.length > 0 && <ChildRows items={view.children} now={now} onOpen={(child) => openSubagentDetail(agent.id, view.runId, child.id)} />}
    </div>
  )

  return (
    <div className="flex flex-col gap-5 px-2 pt-3 pb-6" data-agents-list>
      {active.length > 0 && (
        <Section title={`Active · ${active.length}`} className="[&>div:first-child]:px-2.5">
          <div>{active.map(row)}</div>
        </Section>
      )}
      {finished.length > 0 && (
        <Section title={`Finished · ${finished.length}`} className="[&>div:first-child]:px-2.5">
          <div>{finished.map(row)}</div>
        </Section>
      )}
    </div>
  )
}
