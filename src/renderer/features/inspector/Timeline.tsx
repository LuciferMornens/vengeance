import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronRight, CircleX, FilePen, FilePlus2, FileSearch, FileText, FolderTree, Search, SquareTerminal, Wrench, Activity } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatDuration, pluralize } from '../../lib/format'
import { spring } from '../../lib/motion'
import type { AgentState } from '../../store/agent-state'
import { SegmentedControl, Spinner } from '../../ui'
import { humanizeToolName } from '../tools/tool-utils'
import { pathArg, relativeTo, resultText, toolActivity, type ToolActivity } from './activity'
import { TabEmpty } from './parts'

const TOOL_ICON: Record<string, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  bash: SquareTerminal,
  grep: Search,
  find: FileSearch,
  ls: FolderTree
}

/** The titles the transcript's tool cards use, so a call reads the same in both places. */
const TOOL_TITLE: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  bash: 'Run',
  powershell: 'Run',
  grep: 'Search',
  find: 'Find',
  glob: 'Find',
  ls: 'List',
  ask_user_question: 'Asked',
  ask_user: 'Asked',
  AskUserQuestion: 'Asked',
  question: 'Asked',
  todo: 'Todos',
  todos: 'Todos',
  todo_write: 'Todos',
  TodoWrite: 'Todos',
  web_search: 'Web search',
  websearch: 'Web search',
  WebSearch: 'Web search',
  fetch_content: 'Fetch',
  web_fetch: 'Fetch',
  WebFetch: 'Fetch',
  fetch: 'Fetch',
  get_search_content: 'Read results',
  subagent: 'Subagent',
  subagents: 'Subagent',
  task: 'Subagent',
  Task: 'Subagent',
  codemode: 'Script',
  tool_search: 'Tool search'
}

function toolTitle(name: string): string {
  return TOOL_TITLE[name] ?? humanizeToolName(name)
}

function primaryArg(activity: ToolActivity, cwd: string): string {
  const { args } = activity
  if (Array.isArray(args.tasks)) return pluralize(args.tasks.length, 'task')
  if (typeof args.question === 'string') return args.question
  if (Array.isArray(args.questions) && typeof (args.questions[0] as { question?: unknown } | undefined)?.question === 'string') return (args.questions[0] as { question: string }).question
  const path = pathArg(activity.args)
  if (activity.name === 'bash' && typeof activity.args.command === 'string') return activity.args.command
  if ((activity.name === 'grep' || activity.name === 'find') && typeof activity.args.pattern === 'string') return activity.args.pattern
  if (path) return relativeTo(cwd, path)
  const first = Object.values(activity.args).find((v) => typeof v === 'string' && v.length > 0)
  return typeof first === 'string' ? first : ''
}

/** The locale's short time: "7:36 PM" in 12-hour locales, "07:36" or "7:36" as each 24-hour locale writes it. */
function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { timeStyle: 'short' })
}

function TimelineRow({ activity, cwd, maxDuration, last }: { activity: ToolActivity; cwd: string; maxDuration: number; last: boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[activity.name] ?? Wrench
  const running = activity.status === 'running' || activity.status === 'streaming' || activity.status === 'pending'
  const errorText = activity.isError ? resultText(activity.execution).trim() : ''
  const share = activity.durationMs && maxDuration > 0 ? Math.max(0.04, activity.durationMs / maxDuration) : 0
  return (
    <div className="relative col-span-2 grid grid-cols-subgrid">
      <span className="tabular pt-[9px] text-right text-2xs whitespace-nowrap text-fg-3">
        {clock(activity.at)}
      </span>
      {/* Placed in the second column's area, so it hangs from the icon whatever width the times take. */}
      {!last && (
        <span className="absolute top-[22px] bottom-0 left-[9px] col-start-2 w-px bg-hairline" />
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group col-start-2 flex w-full items-start gap-2.5 rounded-md py-1.5 pr-2 text-left focus-visible:outline-none"
      >
        <span
          className={cn(
            'relative z-10 flex size-[19px] shrink-0 items-center justify-center rounded-sm bg-surface-2 shadow-[0_0_0_1px_var(--hairline-strong)] [&_svg]:size-[11px]',
            activity.isError ? 'text-danger shadow-[0_0_0_1px_color-mix(in_oklab,var(--danger)_45%,transparent)]' : 'text-fg-3'
          )}
        >
          <Icon />
        </span>
        <span className="min-w-0 flex-1 rounded-md transition-colors group-hover:text-fg">
          <span className="flex items-center gap-1.5 text-xs leading-[19px]">
            <span className={cn('shrink-0 font-medium', activity.isError ? 'text-danger' : 'text-fg')} title={activity.name}>
              {toolTitle(activity.name)}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{primaryArg(activity, cwd)}</span>
            <span className="tabular shrink-0 text-2xs text-fg-3">{running ? '' : formatDuration(activity.durationMs)}</span>
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {running ? <Spinner size={11} className="text-accent" /> : activity.isError ? <CircleX className="size-3 text-danger" /> : <Check className="size-3 text-success" />}
            </span>
          </span>
          <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-hover">
            {running ? (
              <span className="block h-full w-1/3 animate-[v-shimmer_1.2s_linear_infinite] rounded-full bg-[linear-gradient(90deg,transparent,var(--accent),transparent)] bg-[length:200%_100%]" />
            ) : (
              <motion.span
                className={cn('block h-full rounded-full', activity.isError ? 'bg-danger' : 'bg-[color-mix(in_oklab,var(--fg-3)_70%,transparent)]')}
                initial={{ width: 0 }}
                animate={{ width: `${share * 100}%` }}
                transition={spring.smooth}
              />
            )}
          </span>
          {errorText && !open && <span className="mt-1 line-clamp-1 text-2xs text-danger/80">{errorText}</span>}
        </span>
        <ChevronRight className={cn('mt-[3px] size-3 shrink-0 text-fg-4 transition-transform', open && 'rotate-90')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.smooth}
            className="col-start-2 overflow-hidden"
          >
            <pre className="selectable mt-0.5 mb-2 ml-[29px] max-h-48 overflow-auto rounded-md bg-surface-2 px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
              {resultText(activity.execution).trim() || JSON.stringify(activity.args, null, 2)}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type Filter = 'all' | 'errors'

export function Timeline({ agent }: { agent: AgentState }) {
  const { entries, streaming, tools } = agent
  const activities = useMemo(() => toolActivity({ entries, streaming, tools }), [entries, streaming, tools])
  const [filter, setFilter] = useState<Filter>('all')
  if (activities.length === 0) {
    return (
      <TabEmpty icon={<Activity />} title="No tool calls yet">
        Every tool the agent runs appears here in order, with its duration and outcome.
      </TabEmpty>
    )
  }
  const errors = activities.filter((a) => a.isError).length
  const shown = filter === 'errors' ? activities.filter((a) => a.isError) : activities
  const maxDuration = Math.max(...activities.map((a) => a.durationMs ?? 0), 1)
  const total = activities.reduce((n, a) => n + (a.durationMs ?? 0), 0)

  return (
    <div className="flex flex-col gap-3 px-3 pt-3 pb-6">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-xs text-fg-3">
          <span className="tabular text-fg-2">{activities.length}</span> calls · <span className="tabular text-fg-2">{formatDuration(total)}</span> in tools
        </span>
        <SegmentedControl<Filter>
          size="sm"
          value={filter}
          onValueChange={setFilter}
          aria-label="Filter tool calls"
          segments={[
            { value: 'all', label: 'All' },
            { value: 'errors', label: errors ? `Errors ${errors}` : 'Errors' }
          ]}
        />
      </div>
      {/* Times in their own column, as wide as the longest one ("12:05 PM" or "12:05"). */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        {shown.map((activity, i) => (
          <TimelineRow key={activity.id} activity={activity} cwd={agent.info.cwd} maxDuration={maxDuration} last={i === shown.length - 1} />
        ))}
        {shown.length === 0 && (
          <div className="col-span-2 px-2 py-6 text-center text-sm text-fg-3">
            No failed tool calls in this session.
          </div>
        )}
      </div>
    </div>
  )
}
