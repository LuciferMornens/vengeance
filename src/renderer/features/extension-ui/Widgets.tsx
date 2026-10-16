import { useMemo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { friendlyExtensionName } from '@shared/display-names'
import { cn } from '../../lib/cn'
import { isMachinePayload } from '../../lib/machine-payload'
import { spring } from '../../lib/motion'
import type { ExtensionWidget } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { AnsiText } from '../../ui'
import { ChecklistCard, useDockedChecklistCollapsed } from './ChecklistCard'
import { parseChecklist } from './checklist'

const EMPTY: Record<string, ExtensionWidget> = {}

/** Glass card stacked above the composer: extension widgets and the docked todo list share it. */
export const aboveEditorCard =
  'pointer-events-auto mb-1.5 rounded-card bg-[var(--glass-strong)] shadow-elev-1 backdrop-blur-xl'

/** Keys of above-editor widgets currently shown as a native checklist (their status chip is redundant). */
export function useChecklistWidgetKeys(agentId: string): string[] {
  const widgets = useAgents((s) => s.agents[agentId]?.ext.widgets ?? EMPTY)
  return useMemo(
    () => Object.entries(widgets).flatMap(([key, widget]) => (widget.placement === 'aboveEditor' && parseChecklist(widget.lines) ? [key] : [])),
    [widgets]
  )
}

/**
 * Extension `setWidget` lines placed around the editor (rpc-extension-ui.md `widgetPlacement`). `aboveEditor`
 * widgets are quiet glass cards stacked above the composer — todo-style lists as a native checklist, anything
 * else as ANSI-aware text; `belowEditor` widgets are a single dim line each under it. The inspector keeps the
 * full list.
 */
export function ExtensionWidgets({ agentId, placement }: { agentId: string; placement: ExtensionWidget['placement'] }) {
  const widgets = useAgents((s) => s.agents[agentId]?.ext.widgets ?? EMPTY)
  // The reducer already routes host payloads to `ext.machine`; this guard keeps any that slip through off screen.
  const entries = Object.entries(widgets).filter(([, widget]) => widget.placement === placement && widget.lines.length > 0 && !isMachinePayload(widget.lines))
  const above = placement === 'aboveEditor'
  const [collapsed, toggleCollapsed] = useDockedChecklistCollapsed()

  return (
    <AnimatePresence initial={false}>
      {entries.map(([key, widget]) => {
        const list = above ? parseChecklist(widget.lines) : null
        const name = friendlyExtensionName(key)
        return (
          <motion.div
            key={key}
            initial={{ opacity: 0, y: above ? 6 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={spring.snappy}
            title={list ? undefined : name}
            data-widget={key}
            className={cn(
              above ? aboveEditorCard : 'pointer-events-auto mt-1.5 px-3',
              above && !list && 'max-h-[148px] overflow-y-auto px-3 py-2'
            )}
          >
            {list ? (
              <ChecklistCard
                list={list}
                name={name}
                docked={{ collapsed, onToggle: toggleCollapsed }}
              />
            ) : (
              <AnsiText
                as="pre"
                text={widget.lines.join('\n')}
                className={cn('font-mono', above ? 'text-xs leading-[1.65] break-words whitespace-pre-wrap text-fg-2' : 'truncate text-2xs leading-5 text-fg-3')}
              />
            )}
          </motion.div>
        )
      })}
    </AnimatePresence>
  )
}
