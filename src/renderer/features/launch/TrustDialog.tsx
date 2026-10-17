import { useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import {
  Clock,
  ExternalLink,
  FileCog,
  Info,
  MessageSquareText,
  Palette,
  Puzzle,
  RotateCcw,
  ScrollText,
  Server,
  ShieldCheck,
  ShieldHalf,
  ShieldOff,
  ShieldQuestion,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import type { TrustChoice, TrustPreflight, TrustResourceKind } from '@shared/api/launch'
import { cn } from '../../lib/cn'
import { basename, pluralize } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { isImeComposing } from '../../lib/keybindings'
import { REVEAL_LABEL, revealLabelFor } from '../../lib/platform-copy'
import { spring } from '../../lib/motion'
import { useAgents } from '../../store/agents'
import { Badge, Checkbox, Tooltip } from '../../ui'
import { LaunchDialogFrame } from './parts'
import { agentsInFolder } from './spawn'
import type { TrustManageChoice, TrustRequest } from './store'

const RESOURCE_META: Record<
  TrustResourceKind,
  { icon: LucideIcon; title: string; detail: string; runsCode?: boolean }
> = {
  settings: {
    icon: FileCog,
    title: 'Project settings',
    detail: 'Overrides engine settings for this folder'
  },
  mcp: { icon: Server, title: 'MCP servers', detail: 'Connects project servers and their tools' },
  extensions: {
    icon: Puzzle,
    title: 'Extensions',
    detail: 'Runs project code when a session starts',
    runsCode: true
  },
  skills: { icon: Sparkles, title: 'Skills', detail: 'Adds project skills to the agent' },
  prompts: {
    icon: MessageSquareText,
    title: 'Prompt templates',
    detail: 'Adds project slash commands'
  },
  themes: { icon: Palette, title: 'Themes', detail: 'Project themes' },
  'system-prompt': {
    icon: ScrollText,
    title: 'System prompt',
    detail: 'Replaces the default system prompt'
  },
  'append-system-prompt': {
    icon: ScrollText,
    title: 'System prompt addition',
    detail: 'Appends instructions to the system prompt'
  },
  'agents-skills': {
    icon: Sparkles,
    title: 'Agent skills',
    detail: 'Shared .agents skills for this project'
  }
}

interface ChoiceOption<C extends string> {
  value: C
  icon: LucideIcon
  title: string
  detail: string
}

const DECIDE_OPTIONS: ChoiceOption<TrustChoice>[] = [
  {
    value: 'trust-remember',
    icon: ShieldCheck,
    title: 'Trust and remember',
    detail: 'Load these now and in every future session.'
  },
  {
    value: 'trust-once',
    icon: ShieldHalf,
    title: 'Trust this time',
    detail: 'Load them for this session only.'
  },
  {
    value: 'distrust-remember',
    icon: ShieldOff,
    title: 'Don’t trust and remember',
    detail: 'Always start sessions here without them.'
  },
  {
    value: 'not-now',
    icon: Clock,
    title: 'Not now',
    detail: 'Start without them and ask again next time.'
  }
]

function manageOptions(preflight: TrustPreflight): ChoiceOption<TrustManageChoice>[] {
  const options: ChoiceOption<TrustManageChoice>[] = [
    {
      value: 'trust-remember',
      icon: ShieldCheck,
      title: 'Trust and remember',
      detail: 'New sessions here load project resources.'
    },
    {
      value: 'distrust-remember',
      icon: ShieldOff,
      title: 'Don’t trust and remember',
      detail: 'New sessions here start without them.'
    }
  ]
  if (preflight.saved !== null) {
    const parent =
      preflight.savedPath && preflight.savedPath.toLowerCase() !== preflight.cwd.toLowerCase()
    options.push({
      value: 'forget',
      icon: RotateCcw,
      title: 'Forget saved decision',
      detail: parent
        ? `Clears the decision saved for ${preflight.savedPath}.`
        : `Falls back to the default (${defaultLabel(preflight)}).`
    })
  }
  return options
}

function defaultLabel(preflight: TrustPreflight): string {
  return preflight.defaultTrust === 'ask'
    ? 'ask every time'
    : preflight.defaultTrust === 'always'
      ? 'always trust'
      : 'never trust'
}

function currentState(preflight: TrustPreflight): {
  label: string
  detail: string
  tone: 'success' | 'neutral'
} {
  if (!preflight.requiresTrust)
    return {
      label: 'Nothing to trust',
      detail: 'No protected project resources were found.',
      tone: 'neutral'
    }
  if (preflight.saved !== null) {
    const where =
      preflight.savedPath && preflight.savedPath.toLowerCase() !== preflight.cwd.toLowerCase()
        ? `saved for ${basename(preflight.savedPath)}`
        : 'saved for this folder'
    return {
      label: preflight.saved ? 'Trusted' : 'Not trusted',
      detail: where,
      tone: preflight.saved ? 'success' : 'neutral'
    }
  }
  return {
    label: preflight.engineDefault ? 'Trusted by default' : 'Not trusted',
    detail: `No saved decision · default: ${defaultLabel(preflight)}`,
    tone: preflight.engineDefault ? 'success' : 'neutral'
  }
}

function ResourceList({ preflight }: { preflight: TrustPreflight }) {
  if (preflight.resources.length === 0) {
    return (
      <div className="px-3.5 py-3 text-sm text-fg-3">
        No protected project resources were found. Sessions here start the same either way.
      </div>
    )
  }
  return (
    <ul className="max-h-[188px] overflow-y-auto py-1">
      {preflight.resources.map((resource) => {
        const meta = RESOURCE_META[resource.kind]
        const Icon = meta.icon
        return (
          <li key={resource.path} className="group/res flex h-8 items-center gap-3 pr-2 pl-3.5">
            <Icon className="size-4 shrink-0 text-fg-3" strokeWidth={1.75} />
            <Tooltip content={<span className="font-mono">{resource.label}</span>} side="left">
              <span className="shrink-0 text-ui font-medium text-fg">{meta.title}</span>
            </Tooltip>
            <span className="min-w-0 flex-1 truncate text-sm text-fg-3">{meta.detail}</span>
            {meta.runsCode && <Badge tone="warning">Runs code</Badge>}
            {resource.entries !== undefined && (
              <span className="tabular w-14 shrink-0 text-right text-xs text-fg-3">
                {pluralize(resource.entries, 'item')}
              </span>
            )}
            <Tooltip content={REVEAL_LABEL}>
              <button
                type="button"
                tabIndex={-1}
                aria-label={revealLabelFor(resource.label)}
                onClick={() => void invoke('sys:reveal', resource.path)}
                className="flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 opacity-0 transition-opacity group-hover/res:opacity-100 hover:bg-hover hover:text-fg"
              >
                <ExternalLink className="size-3.5" />
              </button>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}

function ChoiceList<C extends string>({
  options,
  selected,
  onSelect,
  onChoose
}: {
  options: ChoiceOption<C>[]
  selected: number
  onSelect(index: number): void
  onChoose(value: C): void
}) {
  return (
    <div role="listbox" aria-label="Trust decision" className="space-y-1">
      {options.map((option, index) => {
        const Icon = option.icon
        const active = index === selected
        return (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={active}
            data-autofocus={index === 0 || undefined}
            onFocus={() => onSelect(index)}
            onMouseEnter={() => onSelect(index)}
            onClick={() => onChoose(option.value)}
            className="relative flex h-10 w-full items-center gap-3 rounded-md px-3 text-left outline-none"
          >
            {active && (
              <motion.span
                layoutId="trust-choice"
                transition={spring.snappy}
                className="absolute inset-0 rounded-md bg-hover shadow-[inset_0_0_0_1px_var(--hairline),inset_2px_0_0_var(--accent-2)]"
              />
            )}
            <Icon
              className={cn(
                'relative size-4 shrink-0 transition-colors',
                active ? 'text-fg' : 'text-fg-3'
              )}
              strokeWidth={1.75}
            />
            <span className="relative flex min-w-0 flex-1 items-baseline gap-2.5">
              <span className="shrink-0 text-ui font-medium text-fg">{option.title}</span>
              <span className="truncate text-sm text-fg-3">{option.detail}</span>
            </span>
            <kbd className="tabular relative flex h-5 min-w-5 items-center justify-center rounded-xs bg-hover px-1.5 font-sans text-2xs font-medium text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline),inset_0_-1px_0_var(--hairline)]">
              {index + 1}
            </kbd>
          </button>
        )
      })}
    </div>
  )
}

function Section({
  title,
  aside,
  children
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <h3 className="flex-1 text-xs font-medium text-fg-3">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Trust dialog: lists the protected resources and asks before the engine loads them (r2 WP-A). */
export function TrustDialog({ request, open }: { request: TrustRequest; open: boolean }) {
  const { preflight, mode, engine } = request
  const name = basename(preflight.cwd)
  const options: ChoiceOption<string>[] =
    mode === 'decide' ? DECIDE_OPTIONS : manageOptions(preflight)
  const [selected, setSelected] = useState(0)
  const openHere = useAgents((s) =>
    mode === 'manage' ? agentsInFolder(preflight.cwd, s, engine).length : 0
  )
  const [restartOpen, setRestartOpen] = useState(true)
  const choose = (value: string) =>
    request.resolve(value as TrustChoice | TrustManageChoice, openHere > 0 && restartOpen)
  const dismiss = () => request.resolve(mode === 'decide' ? 'not-now' : null)
  const state = currentState(preflight)

  return (
    <LaunchDialogFrame
      open={open}
      icon={<ShieldQuestion />}
      width={560}
      title={mode === 'decide' ? `Trust “${name}”?` : `Project trust for “${name}”`}
      description={
        mode === 'decide'
          ? 'This folder brings its own engine configuration. Trusting it lets sessions load it and run project extensions with your permissions.'
          : openHere > 0
            ? 'Choose what sessions in this folder load.'
            : 'Choose what new sessions in this folder load.'
      }
      hints={[
        { keys: ['\u2191', '\u2193'], label: 'Choose' },
        { combo: 'enter', label: 'Confirm' },
        { combo: 'escape', label: mode === 'decide' ? 'Not now' : 'Cancel' }
      ]}
      onDismiss={dismiss}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next =
            (selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
          setSelected(next)
          event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus()
        } else if (event.key === 'Enter' && !isImeComposing(event)) {
          event.preventDefault()
          const option = options[selected]
          if (option) choose(option.value)
        } else if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
          const option = options[Number(event.key) - 1]
          if (option) {
            event.preventDefault()
            choose(option.value)
          }
        }
      }}
    >
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 pt-4 pb-4">
        <div className="flex items-center gap-2 rounded-md bg-surface-1 px-3 py-2 shadow-[inset_0_0_0_1px_var(--hairline-soft)]">
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2"
            title={preflight.cwd}
          >
            {preflight.cwd}
          </span>
          {mode === 'manage' && (
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 text-xs',
                state.tone === 'success' ? 'text-success' : 'text-fg-2'
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  state.tone === 'success' ? 'bg-success' : 'bg-fg-3'
                )}
              />
              <span className="font-medium">{state.label}</span>
              <span className="text-fg-3">· {state.detail}</span>
            </span>
          )}
        </div>
        <Section
          title="Found in this folder"
          aside={
            preflight.resources.length > 0 && (
              <span className="tabular text-xs text-fg-3">{preflight.resources.length}</span>
            )
          }
        >
          <div className="rounded-card bg-surface-1 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
            <ResourceList preflight={preflight} />
          </div>
        </Section>
        <ChoiceList
          options={options}
          selected={selected}
          onSelect={setSelected}
          onChoose={choose}
        />
        {openHere > 0 && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 hover:bg-hover">
            <Checkbox
              className="mt-0.5"
              checked={restartOpen}
              onCheckedChange={setRestartOpen}
              aria-label="Restart open sessions"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-ui text-fg">
                Restart {openHere === 1 ? 'the open session' : `${openHere} open sessions`} in this
                folder with the new decision
              </span>
              <span className="block text-xs text-fg-3">
                Each resumes where it left off. A running agent restarts once it finishes.
              </span>
            </span>
          </label>
        )}
        <div className="flex items-start gap-2 px-1 text-xs leading-relaxed text-fg-3">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>
            Context files such as AGENTS.md load either way. Trust controls what loads at startup;
            it doesn’t sandbox the agent.
          </span>
        </div>
      </div>
    </LaunchDialogFrame>
  )
}
