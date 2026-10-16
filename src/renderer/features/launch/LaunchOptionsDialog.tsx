import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { motion } from 'motion/react'
import {
  Boxes,
  Flag,
  Gauge,
  KeyRound,
  Rocket,
  ScrollText,
  SlidersHorizontal,
  Workflow,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { ENGINE_LABELS, type EngineId } from '@shared/api/engine'
import type { LaunchOptions } from '@shared/api/launch'
import { cn } from '../../lib/cn'
import { basename } from '../../lib/format'
import { useHotkey } from '../../lib/keybindings'
import { spring } from '../../lib/motion'
import { Button, Checkbox, Kbd, toast } from '../../ui'
import { EnginePicker } from '../engines/EnginePicker'
import { useEngineCapabilities } from '../engines/registry'
import { newSession } from '../shell/workspace'
import { effectiveLaunchArgs, normalizeLaunchOptions } from './options'
import { EngineCommand, LaunchDialogFrame } from './parts'
import {
  PrimeAutonomousSection,
  PrimeModelsSection,
  PrimePromptSection,
  PrimeResourcesSection
} from './prime-sections'
import {
  EnvironmentSection,
  FlagsSection,
  ModelsSection,
  PromptSection,
  ResourcesSection,
  ToolsSection,
  type SectionProps
} from './sections'
import {
  closeLaunchDialog,
  getWorkspaceLaunchDefaults,
  loadExtensionFlags,
  setWorkspaceLaunchDefaults,
  useLaunch,
  type LaunchDialogState
} from './store'

type SectionId = 'tools' | 'resources' | 'prompt' | 'models' | 'env' | 'flags' | 'autonomous'

interface SectionDef {
  id: SectionId
  label: string
  description: string
  icon: LucideIcon
  component: ComponentType<SectionProps>
  count(options: LaunchOptions): number
}

const countValues = (values: unknown[] | undefined) => values?.length ?? 0
const countEnabled = (...flags: Array<boolean | undefined>) => flags.filter(Boolean).length

const ENVIRONMENT_SECTION: SectionDef = {
  id: 'env',
  label: 'Environment',
  description: 'Variables for the engine process.',
  icon: KeyRound,
  component: EnvironmentSection,
  count: (options) => Object.keys(options.env ?? {}).length
}

const PI_SECTIONS: SectionDef[] = [
  {
    id: 'tools',
    label: 'Tools',
    description: 'Which tools the agent can call.',
    icon: Wrench,
    component: ToolsSection,
    count: (options) =>
      countEnabled(options.noTools, options.noBuiltinTools) +
      countValues(options.tools) +
      countValues(options.excludeTools)
  },
  {
    id: 'resources',
    label: 'Resources',
    description: 'Extensions, skills, templates, context files and MCP.',
    icon: Boxes,
    component: ResourcesSection,
    count: (options) =>
      countEnabled(
        options.noExtensions,
        options.noSkills,
        options.noPromptTemplates,
        options.noContextFiles,
        options.noMcp
      ) +
      countValues(options.extensions) +
      countValues(options.skills) +
      countValues(options.promptTemplates)
  },
  {
    id: 'prompt',
    label: 'System prompt',
    description: 'Replace or extend the system prompt.',
    icon: ScrollText,
    component: PromptSection,
    count: (options) =>
      countEnabled(!!options.systemPrompt) + countValues(options.appendSystemPrompt)
  },
  {
    id: 'models',
    label: 'Models',
    description: 'Model scope for cycling, and offline mode.',
    icon: Gauge,
    component: ModelsSection,
    count: (options) => countValues(options.models) + countEnabled(options.offline)
  },
  ENVIRONMENT_SECTION,
  {
    id: 'flags',
    label: 'Extension flags',
    description: 'Options registered by installed extensions.',
    icon: Flag,
    component: FlagsSection,
    count: (options) => Object.keys(options.extensionFlags ?? {}).length
  }
]

const PRIME_SECTIONS: SectionDef[] = [
  {
    id: 'resources',
    label: 'Resources',
    description: 'Skills and prompt templates for this session.',
    icon: Boxes,
    component: PrimeResourcesSection,
    count: (options) =>
      countValues(options.prime?.skills) + countValues(options.prime?.promptTemplates)
  },
  {
    id: 'prompt',
    label: 'System prompt',
    description: 'Replace or extend the system prompt.',
    icon: ScrollText,
    component: PrimePromptSection,
    count: (options) =>
      countEnabled(!!options.prime?.systemPrompt) + countValues(options.prime?.appendSystemPrompt)
  },
  {
    id: 'models',
    label: 'Models',
    description: 'Model scope for startup and cycling.',
    icon: Gauge,
    component: PrimeModelsSection,
    count: (options) => countValues(options.prime?.models)
  },
  {
    id: 'autonomous',
    label: 'Autonomous work',
    description: 'Continuation limits and completion checks.',
    icon: Workflow,
    component: PrimeAutonomousSection,
    count: (options) =>
      Object.values(options.prime?.autonomous ?? {}).filter((value) => value !== undefined).length
  },
  ENVIRONMENT_SECTION
]

/** Launch options editor: workspace defaults, or one new session with options (pre-filled from the defaults). */
export function LaunchOptionsDialog({ state, open }: { state: LaunchDialogState; open: boolean }) {
  const { cwd, mode, engine } = state
  const name = basename(cwd)
  const capabilities = useEngineCapabilities(engine)
  const [drafts, setDrafts] = useState<Partial<Record<EngineId, LaunchOptions>>>(() => ({
    [engine]: structuredClone(getWorkspaceLaunchDefaults(cwd, engine) ?? {})
  }))
  const draft = drafts[engine] ?? {}
  const [section, setSection] = useState<SectionId>('tools')
  const [saveAsDefaults, setSaveAsDefaults] = useState(false)
  // Bumped by "Reset all" so sections holding local row state (environment) re-read the draft.
  const [resetCount, setResetCount] = useState(0)
  const normalized = useMemo(() => normalizeLaunchOptions(draft, engine), [draft, engine])
  const sections = (engine === 'pi' ? PI_SECTIONS : PRIME_SECTIONS).filter((item) => {
    if (item.id === 'env') return true
    if (capabilities?.launchOptions === false) return false
    return item.id !== 'resources' || capabilities?.resources !== false
  })
  const active = sections.find((item) => item.id === section) ?? sections[0]!
  const Section = active.component
  const patchDraft = (change: Partial<LaunchOptions>) =>
    setDrafts((current) => ({
      ...current,
      [engine]: { ...current[engine], ...change }
    }))
  const chooseEngine = (next: EngineId) => {
    setDrafts((current) => ({
      ...current,
      [next]: current[next] ?? structuredClone(getWorkspaceLaunchDefaults(cwd, next) ?? {})
    }))
    useLaunch.setState({ dialog: { ...state, engine: next } })
  }

  useEffect(() => {
    void loadExtensionFlags(cwd, engine)
  }, [cwd, engine])

  const submit = () => {
    if (mode === 'workspace' || saveAsDefaults) setWorkspaceLaunchDefaults(cwd, normalized, engine)
    closeLaunchDialog()
    if (mode === 'session')
      void newSession({ cwd, engine, launch: normalized }, { workspaceDefaults: false })
    else
      toast({
        level: 'success',
        title: 'Launch options saved',
        description: `New ${ENGINE_LABELS[engine]} sessions in ${name} start with them.`
      })
  }
  useHotkey('mod+enter', () => submit(), open)

  return (
    <LaunchDialogFrame
      open={open}
      icon={mode === 'session' ? <Rocket /> : <SlidersHorizontal />}
      width={820}
      bodyClassName="h-[min(560px,calc(82vh-220px))] flex-none overflow-hidden"
      title={mode === 'session' ? 'New session with options' : 'Launch options'}
      description={
        mode === 'session'
          ? `Starts in ${name} with the selected engine’s defaults.`
          : `Defaults for new ${ENGINE_LABELS[engine]} sessions in ${name}. A session can override them.`
      }
      onDismiss={closeLaunchDialog}
      footerStart={
        mode === 'session' ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-2 select-none">
            <Checkbox
              aria-label="Also save as workspace defaults"
              checked={saveAsDefaults}
              onCheckedChange={setSaveAsDefaults}
            />
            Also save as defaults for {name}
          </label>
        ) : (
          normalized && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDrafts((current) => ({ ...current, [engine]: {} }))
                setResetCount((n) => n + 1)
              }}
            >
              Reset all
            </Button>
          )
        )
      }
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={closeLaunchDialog}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={submit}
            trailing={
              <Kbd
                combo="mod+enter"
                size="xs"
                className="ml-1 [&_kbd]:bg-white/15 [&_kbd]:text-accent-fg [&_kbd]:shadow-none"
              />
            }
          >
            {mode === 'session' ? 'Start session' : 'Save defaults'}
          </Button>
        </>
      }
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-hairline-soft px-4 py-2.5">
        <span className="text-ui font-medium text-fg-2">Engine</span>
        <EnginePicker
          value={engine}
          onValueChange={chooseEngine}
          label="Launch engine"
          className="w-[208px]"
        />
        <span className="min-w-0 flex-1 text-right text-xs text-fg-3">
          Defaults are saved separately for each engine.
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Launch option sections"
          className="flex w-[196px] shrink-0 flex-col gap-0.5 border-r border-hairline-soft bg-[color-mix(in_oklab,var(--surface-1)_60%,transparent)] p-2"
        >
          {sections.map((s) => {
            const Icon = s.icon
            const count = s.count(draft)
            const selected = s.id === active.id
            return (
              <button
                key={s.id}
                type="button"
                data-section={s.id}
                data-autofocus={selected || undefined}
                aria-current={selected ? 'page' : undefined}
                onClick={() => setSection(s.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                  event.preventDefault()
                  const index = sections.findIndex((x) => x.id === s.id)
                  const next =
                    sections[
                      (index + (event.key === 'ArrowDown' ? 1 : -1) + sections.length) %
                        sections.length
                    ]!
                  setSection(next.id)
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLElement>(`[data-section="${next.id}"]`)
                    ?.focus()
                }}
                className={cn(
                  'relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-ui outline-none transition-colors',
                  'focus-visible:shadow-[0_0_0_1px_color-mix(in_oklab,var(--fg)_24%,transparent)]',
                  selected ? 'text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'
                )}
              >
                {selected && (
                  <motion.span
                    layoutId="launch-section"
                    transition={spring.snappy}
                    className="absolute inset-0 rounded-md bg-active shadow-[inset_0_0_0_1px_var(--hairline)]"
                  />
                )}
                <Icon
                  className={cn('relative size-4 shrink-0', selected ? 'text-fg' : 'text-fg-3')}
                  strokeWidth={1.75}
                />
                <span className="relative flex-1 truncate font-medium">{s.label}</span>
                {count > 0 && (
                  <span className="tabular relative rounded-xs bg-surface-4 px-1.5 text-2xs leading-[18px] font-semibold text-fg-2">
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            data-launch-scroll
            className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5"
            key={`${engine}-${active.id}-${resetCount}`}
          >
            <div className="mb-4">
              <h2 className="heading text-md font-semibold text-fg">{active.label}</h2>
              <p className="mt-0.5 text-sm text-fg-3">{active.description}</p>
            </div>
            <Section draft={draft} patch={patchDraft} cwd={cwd} engine={engine} />
          </div>
          <EngineCommand
            args={effectiveLaunchArgs({ engine, launch: normalized })}
            envKeys={Object.keys(normalized?.env ?? {})}
            engine={engine}
            configuration={normalized?.prime}
            className="border-t border-hairline-soft px-5 py-1.5"
          />
        </div>
      </div>
    </LaunchDialogFrame>
  )
}
