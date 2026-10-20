import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { PanelRight } from 'lucide-react'
import { create } from 'zustand'
import { friendlyExtensionName } from '@shared/display-names'
import { SUBAGENT_HIDDEN_STATUS_KEYS } from '@shared/subagents'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import { stripAnsi } from '../../lib/ansi'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { AnsiText, Button, Popover } from '../../ui'
import { extensionKeyName } from './checklist'
import { formatLspStatus, hidesIdleLsp, isLspActive, LSP_STATUS_KEY, type LspChip, type LspTone } from './lsp-status'
import { useChecklistWidgetKeys } from './Widgets'

const MAX_VISIBLE = 4
/** pi-mcp-adapter's footer status. */
const ADAPTER_MCP_STATUS_KEY = 'mcp'

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

/** The focus ring sits inside the chip: the row clips anything drawn around it. */
const chipClass =
  'pressable inline-flex h-[22px] items-center gap-1.5 rounded-sm bg-[var(--glass-strong)] px-2 text-xs text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)] backdrop-blur-xl transition-colors duration-[var(--dur-instant)] hover:text-fg focus-visible:-outline-offset-2'

const LSP_DOT: Record<LspTone, string> = {
  success: 'bg-success',
  idle: 'shadow-[inset_0_0_0_1.25px_var(--fg-3)]',
  warning: 'bg-warning'
}

/** Everything a chip abbreviates: each extension's name, its status key and the full text. */
function StatusDetails({ entries, onClose }: { entries: Array<[string, string]>; onClose: () => void }) {
  return (
    <div className="flex max-h-[360px] flex-col" data-status-details>
      <div className="-mx-1.5 min-h-0 flex-1 overflow-y-auto px-1.5">
        {entries.map(([key, text]) => (
          <div key={key} className="rounded-md px-2.5 py-2">
            <div className="flex items-baseline gap-1.5 text-sm font-medium text-fg">
              {friendlyExtensionName(key)}
              <span className="font-mono text-2xs font-normal text-fg-3">{key}</span>
            </div>
            <AnsiText text={text} className="selectable mt-0.5 block text-xs break-words whitespace-pre-wrap text-fg-2" />
          </div>
        ))}
      </div>
      <div className="mt-1 flex shrink-0 border-t border-hairline-soft px-1 pt-1.5">
        <Button
          size="xs"
          variant="ghost"
          leading={<PanelRight />}
          onClick={() => {
            onClose()
            useApp.getState().setInspectorTab('extensions')
          }}
        >
          Open extensions in the inspector
        </Button>
      </div>
    </div>
  )
}

/** A status chip that opens its details; nothing on the row is display-only. */
function DetailsChip({
  entries,
  label,
  children,
  className,
  ...data
}: {
  entries: Array<[string, string]>
  label: string
  children: ReactNode
  className?: string
} & Record<`data-${string}`, string>) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      className="w-[340px] p-1.5"
      trigger={
        <button type="button" aria-label={label} className={cn(chipClass, className)} {...data}>
          {children}
        </button>
      }
    >
      <StatusDetails entries={entries} onClose={() => setOpen(false)} />
    </Popover>
  )
}

/** pi-lens language servers in words: the first state as a chip, any further one folded into `+1`. */
function LspChips({ chips, text }: { chips: LspChip[]; text: string }) {
  const [first, ...rest] = chips
  if (!first) return null
  const entries: Array<[string, string]> = [
    [LSP_STATUS_KEY, chips.map((chip) => `${chip.label}. ${chip.tooltip}`).join('\n') || text]
  ]
  return (
    <span className="inline-flex items-center gap-1.5">
      <DetailsChip entries={entries} label={`${first.label}. ${first.tooltip}`} className="max-w-[240px]" data-lsp-chip={first.tone}>
        <span className={cn('size-1.5 shrink-0 rounded-full', LSP_DOT[first.tone])} aria-hidden />
        <span className="truncate">{first.label}</span>
      </DetailsChip>
      {rest.length > 0 && (
        <DetailsChip entries={entries} label={`${rest.length} more language servers`} className="tabular text-fg-3">
          <span className={cn('size-1.5 shrink-0 rounded-full', LSP_DOT[rest[0]!.tone])} aria-hidden />+{rest.length}
        </DetailsChip>
      )}
    </span>
  )
}

function StatusChip({ statusKey, text }: { statusKey: string; text: string }) {
  const lsp = statusKey === LSP_STATUS_KEY ? formatLspStatus(text) : null
  if (lsp) return <LspChips chips={lsp} text={text} />
  return (
    <DetailsChip
      entries={[[statusKey, text]]}
      label={`${friendlyExtensionName(statusKey)}: ${stripAnsi(text)}`}
      className="max-w-[240px]"
      data-status-chip={statusKey}
    >
      {needsLabel(statusKey, text) && <span className="shrink-0 text-fg-3">{friendlyExtensionName(statusKey)}</span>}
      <AnsiText text={text} className="truncate" />
    </DetailsChip>
  )
}

/** Subtle row of extension `setStatus` entries, docked above the composer. */
export function ExtensionStatusChips({ agentId }: { agentId: string }) {
  const statuses = useAgents((s) => s.agents[agentId]?.ext.statuses)
  // pi-mcp-adapter's "MCP: N servers" summary; the MCP chip shows its servers one by one.
  const adapterMcp = useAgents((s) => s.agents[agentId]?.mcp?.source === 'adapter')
  // A todo widget shown as a checklist already carries its progress; its "2/3 done" chip would repeat it.
  const checklists = new Set(useChecklistWidgetKeys(agentId).map(extensionKeyName))
  const hiddenLsp = useHiddenIdleLsp(agentId, statuses?.[LSP_STATUS_KEY])
  const entries = Object.entries(statuses ?? {}).filter(
    ([key, text]) =>
      text.trim() !== '' &&
      !checklists.has(extensionKeyName(key)) &&
      !SUBAGENT_HIDDEN_STATUS_KEYS.includes(key) &&
      !(hiddenLsp && key === LSP_STATUS_KEY) &&
      !(adapterMcp && key === ADAPTER_MCP_STATUS_KEY)
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
        <DetailsChip entries={hidden} label={`${hidden.length} more extension statuses`} className="tabular text-fg-3">
          +{hidden.length}
        </DetailsChip>
      )}
    </div>
  )
}
