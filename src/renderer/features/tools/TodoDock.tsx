import { useMemo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { spring } from '../../lib/motion'
import { useAgents } from '../../store/agents'
import {
  aboveEditorCard,
  ChecklistCard,
  useChecklistWidgetKeys,
  useDockedChecklistCollapsed
} from '../extension-ui'
import { dockedTodos } from './todo-state'

const NO_ENTRIES: never[] = []

/**
 * The session's todo list above the composer, from its todo tool results. Its heading collapses
 * it to the current task. An extension that draws its own checklist widget there takes precedence.
 */
export function TodoDock({ agentId }: { agentId: string }) {
  const entries = useAgents((state) => state.agents[agentId]?.entries ?? NO_ENTRIES)
  const list = useMemo(() => dockedTodos(entries), [entries])
  const widgetShowsList = useChecklistWidgetKeys(agentId).length > 0
  const [collapsed, toggleCollapsed] = useDockedChecklistCollapsed()

  return (
    <AnimatePresence initial={false}>
      {list && !widgetShowsList && (
        <motion.div
          key="todos"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={spring.snappy}
          data-todo-dock
          className={aboveEditorCard}
        >
          <ChecklistCard
            list={list}
            name="Todos"
            docked={{ collapsed, onToggle: toggleCollapsed }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
