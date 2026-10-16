import { cn } from '../../../lib/cn'
import { useAgents } from '../../../store/agents'
import { StateGlyph } from '../../extension-ui'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { tasksOf, taskState, TODO_TOOL_NAMES, type Task } from '../todo-state'
import { DetailNote, RowDetail, ToolRow } from '../ToolRow'
import { firstLine, isActive, isRecord, num, payloadText, records, resultPayload, str, toolPhase } from '../tool-utils'

function actionLabel(args: Record<string, unknown>, tasks: Task[]): string {
  const action = str(args.action) ?? ''
  const id = num(args.id)
  const target = id !== undefined ? tasks.find((t) => t.id === id) : undefined
  switch (action) {
    case 'create':
      return `Added “${str(args.subject) ?? target?.subject ?? 'task'}”`
    case 'create_many': {
      const count = records(args.tasks).length
      return `Planned ${count} ${count === 1 ? 'task' : 'tasks'}`
    }
    case 'update': {
      const status = str(args.status)
      const name = target?.subject ?? (id !== undefined ? `#${id}` : 'task')
      if (status === 'completed') return `Completed “${name}”`
      if (status === 'in_progress') return `Started “${name}”`
      if (status === 'deleted') return `Removed “${name}”`
      return `Updated “${name}”`
    }
    case 'delete':
      return `Removed ${target ? `“${target.subject}”` : id !== undefined ? `#${id}` : 'task'}`
    case 'clear':
      return 'Cleared the list'
    case 'list':
      return 'Reviewed the list'
    case 'get':
      return target ? `Looked at “${target.subject}”` : 'Looked at a task'
    default:
      return action ? action.replace(/_/g, ' ') : 'Updated'
  }
}

function TaskList({ tasks, changedId }: { tasks: Task[]; changedId: number | undefined }) {
  return (
    <ul className="py-1.5">
      {tasks.map((task) => (
        <li key={task.id} className={cn('flex items-start gap-3 px-3.5 py-[5px]', task.id === changedId && 'bg-[var(--accent-softer)]')}>
          <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center">
            <StateGlyph state={taskState(task.status)} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn('block text-ui leading-snug', task.status === 'completed' ? 'text-fg-3 line-through decoration-fg-4' : 'text-fg')}>
              {task.subject}
            </span>
            {task.status === 'in_progress' && task.activeForm && <span className="block text-xs text-accent-text">{task.activeForm}</span>}
          </span>
          <span className="shrink-0 pt-px text-2xs text-fg-3 tabular">#{task.id}</span>
        </li>
      ))}
    </ul>
  )
}

function TodoRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const payload = resultPayload(execution)
  const details = isRecord(payload?.details) ? payload.details : undefined
  const fromResult = tasksOf(details?.tasks).filter((t) => t.status !== 'deleted')
  const tasks = fromResult.length > 0 ? fromResult : tasksOf(call.arguments.tasks)
  const done = tasks.filter((t) => t.status === 'completed').length
  const changedId = num(call.arguments.id)
  const error = str(details?.error) ?? (phase === 'error' ? payloadText(payload) : undefined)
  const listText = tasks.map((task) => `${task.status === 'completed' ? '[x]' : '[ ]'} ${task.subject}`).join('\n')
  return (
    <ToolRow
      verb={isActive(phase) ? 'Updating todos' : 'Updated todos'}
      subject={<span className="min-w-0 truncate">{actionLabel(call.arguments, tasks)}</span>}
      meta={tasks.length > 0 ? <span>{done} of {tasks.length} done</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={error ? firstLine(error) : undefined}
      sublineTone="danger"
      detail={
        tasks.length > 0 || error ? (
          <RowDetail copy={listText}>
            {error && <DetailNote tone="danger">{error}</DetailNote>}
            {tasks.length > 0 && <TaskList tasks={tasks} changedId={changedId} />}
          </RowDetail>
        ) : undefined
      }
    />
  )
}

registerToolRenderer(TODO_TOOL_NAMES, TodoRow)
