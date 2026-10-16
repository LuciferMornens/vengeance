import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { create } from 'zustand'
import { friendlyExtensionName } from '@shared/display-names'
import { SUBAGENT_HIDDEN_STATUS_KEYS } from '@shared/subagents'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import { useAgents } from '../../store/agents'
import { AnsiText, Tooltip } from '../../ui'
import { extensionKeyName } from './checklist'
import { formatLspStatus, hidesIdleLsp, isLspActive, LSP_STATUS_KEY, type LspChip, type LspTone } from './lsp-status'
import { useChecklistWidgetKeys } from './Widgets'

const MAX_VISIBLE = 4

/** Sessions (`<agentId>:<sessionId>`) in which a language server has run. */
const useLspHistory = create<{ active: Record<string, true>; markActive(sessionKey: string): void }>()((set) => ({
  active: {},
  markActive: (sessionKey) => set((s) => (s.active[sessionKey] ? s : { active: { ...s.active, [sessionKey]: true } }))
}))

/** True when the LSP status is idle and no language server has run in this session yet (the chip stays hidden). */
function useHiddenIdleLsp(agentId: string, lspText: string | undefined): boolean {
  const sessionKey = useAgents((s) => `${agentId}:${s.agents[agentId]?.session?.sessionId ?? ''}`)
  const chips = lspText ? formatLspStatus(lspText) : null
  const active = isLspActive(chips)
  const activeEarlier = useLspHistory((s) => s.active[sessionKey] === true)
  useEffect(() => {
    if (active) useLspHistory.getState().markActive(sessionKey)
  }, [active, sessionKey])
  return hidesIdleLsp(chips, activeEarlier || active)
}

/** Show the name next to the text only when the text does not already say it ("Index ready" for `pi-index`). */
function needsLabel(key: string, text: string): boolean {
  const lower = text.toLowerCase()
  return !friendlyExtensionName(key)
    .toLowerCase()
    .split(' ')
    .some((word) => word.length > 2 && lower.includes(word))
}

/** Chip tooltip: the friendly name, with the technical status key as secondary text. */
function StatusName({ statusKey }: { statusKey: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      {friendlyExtensionName(statusKey)}
      <span className="font-mono text-2xs font-normal text-fg-3">{statusKey}</span>
    </span>
  )
}

const chipClass = 'inline-flex h-[22px] items-center gap-1.5 rounded-sm bg-[var(--glass-strong)] px-2 text-xs text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)] backdrop-blur-xl'

const LSP_DOT: Record<LspTone, string> = {
  success: 'bg-success',
  idle: 'shadow-[inset_0_0_0_1.25px_var(--fg-3)]',
  warning: 'bg-warning'
}

/** pi-lens language servers in words: the first state as a chip, any further one folded into `+1`. */
function LspChips({ chips }: { chips: LspChip[] }) {
  const [first, ...rest] = chips
  if (!first) return null
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tooltip content={first.tooltip} side="top">
        <span data-lsp-chip={first.tone} className={cn(chipClass, 'max-w-[240px]')}>
          <span className={cn('size-1.5 shrink-0 rounded-full', LSP_DOT[first.tone])} aria-hidden />
          <span className="truncate">{first.label}</span>
        </span>
      </Tooltip>
      {rest.length > 0 && (
        <Tooltip
          side="top"
          content={
            <span className="flex max-w-[280px] flex-col gap-1">
              {rest.map((chip) => (
                <span key={chip.label}>
                  <span className="font-medium">{chip.label}.</span> {chip.tooltip}
                </span>
              ))}
            </span>
          }
        >
          <span className={cn(chipClass, 'tabular text-fg-3')}>
            <span className={cn('size-1.5 shrink-0 rounded-full', LSP_DOT[rest[0]!.tone])} aria-hidden />+{rest.length}
          </span>
        </Tooltip>
      )}
    </span>
  )
}

function StatusChip({ statusKey, text }: { statusKey: string; text: string }) {
  const lsp = statusKey === LSP_STATUS_KEY ? formatLspStatus(text) : null
  if (lsp) return <LspChips chips={lsp} />
  return (
    <Tooltip content={<StatusName statusKey={statusKey} />} side="top">
      <span className={cn(chipClass, 'max-w-[240px]')}>
        {needsLabel(statusKey, text) && <span className="shrink-0 text-fg-3">{friendlyExtensionName(statusKey)}</span>}
        <AnsiText text={text} className="truncate" />
      </span>
    </Tooltip>
  )
}

/** Subtle row of extension `setStatus` entries, docked above the composer. */
export function ExtensionStatusChips({ agentId }: { agentId: string }) {
  const statuses = useAgents((s) => s.agents[agentId]?.ext.statuses)
  // A todo widget shown as a checklist already carries its progress; its "2/3 done" chip would repeat it.
  const checklists = new Set(useChecklistWidgetKeys(agentId).map(extensionKeyName))
  const hiddenLsp = useHiddenIdleLsp(agentId, statuses?.[LSP_STATUS_KEY])
  const entries = Object.entries(statuses ?? {}).filter(
    ([key, text]) =>
      text.trim() !== '' && !checklists.has(extensionKeyName(key)) && !SUBAGENT_HIDDEN_STATUS_KEYS.includes(key) && !(hiddenLsp && key === LSP_STATUS_KEY)
  )
  const visible = entries.slice(0, MAX_VISIBLE)
  const hidden = entries.slice(MAX_VISIBLE)

  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <AnimatePresence initial={false}>
        {visible.map(([key, text]) => (
          <motion.div
            key={key}
            layout
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={spring.snappy}
          >
            <StatusChip statusKey={key} text={text} />
          </motion.div>
        ))}
      </AnimatePresence>
      {hidden.length > 0 && (
        <Tooltip
          side="top"
          content={
            <span className="flex flex-col gap-0.5">
              {hidden.map(([key, text]) => (
                <span key={key}>
                  <span className="text-fg-3">{friendlyExtensionName(key)}</span> <AnsiText text={text} />
                </span>
              ))}
            </span>
          }
        >
          <span className={cn(chipClass, 'tabular text-fg-3')}>+{hidden.length}</span>
        </Tooltip>
      )}
    </div>
  )
}
