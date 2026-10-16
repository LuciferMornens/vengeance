import type { TranscriptEntry } from '../../store/agent-state'
import type { Checklist, ChecklistState } from '../extension-ui'
import { isRecord, num, records, str } from './tool-utils'

/** Tool names whose results carry a task list (rpiv-todo's `todo` and common equivalents). */
export const TODO_TOOL_NAMES = ['todo', 'todos', 'todo_write', 'TodoWrite']

/** rpiv-todo task (tool/types.ts in @juicesharp/rpiv-todo). */
export interface Task {
  id: number
  subject: string
  status: string
  activeForm?: string
  description?: string
}

export function tasksOf(value: unknown): Task[] {
  return records(value).map((task, index) => ({
    id: num(task.id) ?? index + 1,
    subject: str(task.subject) ?? str(task.title) ?? str(task.content) ?? '',
    status: str(task.status) ?? 'pending',
    activeForm: str(task.activeForm),
    description: str(task.description)
  }))
}

export function taskState(status: string): ChecklistState {
  if (status === 'completed') return 'done'
  if (status === 'in_progress') return 'active'
  if (status === 'deleted') return 'cancelled'
  return 'open'
}

/**
 * The task list docked above the composer, rebuilt from the latest todo tool result on the branch.
 * The Engine drops rpiv-todo's own overlay (a TUI component, not text lines), so the app draws it.
 * Like that overlay, a task completed during an earlier prompt drops out of the dock; the dock is
 * empty once every task is gone or finished before the current prompt.
 */
export function dockedTodos(entries: TranscriptEntry[]): Checklist | null {
  let prompt = 0
  let nextId = 0
  let tasks: Task[] = []
  const completedInPrompt = new Map<number, number>()
  for (const { message } of entries) {
    if (message.role === 'user') {
      prompt++
      continue
    }
    if (message.role !== 'toolResult' || !TODO_TOOL_NAMES.includes(message.toolName)) continue
    const details = message.details
    const snapshotNextId = isRecord(details) ? num(details.nextId) : undefined
    if (!isRecord(details) || !Array.isArray(details.tasks) || snapshotNextId === undefined)
      continue
    // A lower next id means the list was cleared and numbering restarted.
    if (snapshotNextId < nextId) completedInPrompt.clear()
    nextId = snapshotNextId
    tasks = tasksOf(details.tasks)
    for (const task of tasks) {
      if (task.status !== 'completed') completedInPrompt.delete(task.id)
      else if (!completedInPrompt.has(task.id)) completedInPrompt.set(task.id, prompt)
    }
  }

  const visible = tasks.filter(
    (task) =>
      task.status !== 'deleted' &&
      (task.status !== 'completed' || completedInPrompt.get(task.id) === prompt)
  )
  if (visible.length === 0) return null
  return {
    title: 'Todos',
    done: visible.filter((task) => task.status === 'completed').length,
    total: visible.length,
    items: visible.map((task) => ({ text: task.subject, state: taskState(task.status) }))
  }
}
