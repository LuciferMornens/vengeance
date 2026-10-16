import { useState } from 'react'
import { Braces, ChevronRight, CircleAlert, Puzzle } from 'lucide-react'
import { friendlyExtensionName } from '@shared/display-names'
import type { RpcSlashCommand } from '@shared/engine-types'
import { stripAnsi } from '../../lib/ansi'
import { cn } from '../../lib/cn'
import { basename } from '../../lib/format'
import type { AgentState, MachinePayload } from '../../store/agent-state'
import { AnsiText } from '../../ui'
import { ChecklistCard, formatLspStatus, LSP_STATUS_KEY, parseChecklist } from '../extension-ui'
import { Section, TabEmpty, Well } from './parts'

/** The package an extension command came from (`npm:pi-todos` → `pi-todos`). */
function sourceName(command: RpcSlashCommand): string {
  const info = command.sourceInfo
  if (info.baseDir) return basename(info.baseDir)
  return info.source.replace(/^npm:/, '') || basename(info.path)
}

/** pi-lens' LSP status in the same words as the composer chip; other statuses as sent. */
function StatusText({ statusKey, text }: { statusKey: string; text: string }) {
  const lsp = statusKey === LSP_STATUS_KEY ? formatLspStatus(text) : null
  if (!lsp) return <AnsiText text={text} className="min-w-0 flex-1 truncate text-right text-sm text-fg" />
  return (
    <span className="min-w-0 flex-1 truncate text-right text-sm text-fg" title={lsp.map((chip) => chip.tooltip).join(' ')}>
      {lsp.map((chip) => chip.label).join(' · ')}
    </span>
  )
}

/** Pretty JSON when the payload (minus a `PREFIX:` envelope) parses, else the text as received. */
function machineText(payload: MachinePayload): string {
  const text = stripAnsi(payload.lines.join('\n')).trim()
  const body = text.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, '')
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return text
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

/** One collapsed row per host payload (JSON envelopes from extensions); expands to the formatted data. */
function MachineDataRow({ statusKey, payload }: { statusKey: string; payload: MachinePayload }) {
  const [open, setOpen] = useState(false)
  const bytes = new TextEncoder().encode(payload.lines.join('\n')).length
  return (
    <div data-machine-row={statusKey}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-hover">
        <ChevronRight className={cn('size-3.5 shrink-0 text-fg-3 transition-transform duration-[var(--dur-instant)]', open && 'rotate-90')} />
        <span className="min-w-0 truncate text-sm text-fg-2" title={statusKey}>
          {friendlyExtensionName(statusKey)}
        </span>
        <span className="ml-auto shrink-0 text-xs text-fg-3 tabular">machine data · {formatSize(bytes)}</span>
      </button>
      {open && <pre className="selectable max-h-72 overflow-auto border-t border-hairline-soft px-3 py-2.5 font-mono text-xs leading-relaxed text-fg-2">{machineText(payload)}</pre>}
    </div>
  )
}

export function Extensions({ agent }: { agent: AgentState }) {
  const statuses = Object.entries(agent.ext.statuses)
  const widgets = Object.entries(agent.ext.widgets)
  const machine = Object.entries(agent.ext.machine)
  const errors = agent.extensionErrors
  const commands = agent.commands.filter((c) => c.source === 'extension')
  const bySource = new Map<string, RpcSlashCommand[]>()
  for (const command of commands) bySource.set(sourceName(command), [...(bySource.get(sourceName(command)) ?? []), command])

  if (statuses.length + widgets.length + machine.length + errors.length + commands.length === 0) {
    return (
      <TabEmpty icon={<Puzzle />} title="No extension activity">
        Status lines, widgets and commands from your installed extensions appear here.
      </TabEmpty>
    )
  }

  return (
    <div className="flex flex-col gap-5 px-4 pt-3 pb-6">
      {errors.length > 0 && (
        <Section title={`Errors · ${errors.length}`}>
          <div className="flex flex-col gap-1.5">
            {errors.slice(-8).reverse().map((error, i) => (
              <div key={i} className="flex items-start gap-2.5 rounded-card bg-danger-soft px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--danger)_25%,transparent)]">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-fg">
                    {basename(error.extensionPath)} <span className="font-normal text-fg-3">· {error.event}</span>
                  </div>
                  <div className="selectable mt-0.5 line-clamp-3 font-mono text-xs leading-relaxed break-words text-danger">{error.error}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {statuses.length > 0 && (
        <Section title="Status">
          <Well className="divide-y divide-hairline-soft">
            {statuses.map(([key, text]) => (
              <div key={key} className="flex min-h-9 items-center gap-3 px-3 py-1.5">
                <span className="shrink-0 text-sm text-fg-3" title={key}>
                  {friendlyExtensionName(key)}
                </span>
                <StatusText statusKey={key} text={text} />
              </div>
            ))}
          </Well>
        </Section>
      )}

      {widgets.length > 0 && (
        <Section title="Widgets">
          <div className="flex flex-col gap-2">
            {widgets.map(([key, widget]) => {
              const list = parseChecklist(widget.lines)
              return (
                <Well key={key} className="overflow-hidden">
                  {list ? (
                    <ChecklistCard list={list} name={friendlyExtensionName(key)} className="pb-2" />
                  ) : (
                    <>
                      <div className="flex h-7 items-center gap-2 border-b border-hairline-soft px-3">
                        <Puzzle className="size-3 text-fg-3" />
                        <span className="text-xs font-medium text-fg-2" title={key}>
                          {friendlyExtensionName(key)}
                        </span>
                      </div>
                      <AnsiText as="pre" text={widget.lines.join('\n')} className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-[1.75] text-fg-2" />
                    </>
                  )}
                </Well>
              )
            })}
          </div>
        </Section>
      )}

      {machine.length > 0 && (
        <Section title="Machine data" aside={<Braces className="size-3.5 text-fg-4" />}>
          <Well className="divide-y divide-hairline-soft overflow-hidden">
            {machine.map(([key, payload]) => (
              <MachineDataRow key={key} statusKey={key} payload={payload} />
            ))}
          </Well>
        </Section>
      )}

      {bySource.size > 0 && (
        <Section title="Commands">
          <Well className="divide-y divide-hairline-soft">
            {[...bySource].map(([source, list]) => (
              <div key={source} className="px-3 py-2.5">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-fg-2" title={source}>
                  <Puzzle className="size-3.5 text-fg-3" />
                  {friendlyExtensionName(source)}
                </div>
                <div className="flex flex-col gap-1">
                  {list.map((command) => (
                    <div key={command.name} className="flex items-baseline gap-2 pl-[22px] text-xs">
                      <span className="shrink-0 font-mono text-xs text-fg-2">/{command.name}</span>
                      {command.description && <span className="min-w-0 truncate text-fg-3">{command.description}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </Well>
        </Section>
      )}
    </div>
  )
}
