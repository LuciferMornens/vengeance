import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Command } from 'cmdk'
import { Brain, ChevronDown, ImageIcon, Search } from 'lucide-react'
import type { ProviderInfo } from '@shared/api/settings'
import type { Model } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import { formatTokens } from '../../lib/format'
import { on } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { Badge, ListRowContent, listRowClass, Popover, Spinner } from '../../ui'
import { providerName } from '../settings/provider-name'
import { useCatalogProviders } from './catalog-providers'
import { toastFailure } from './failure-toast'

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  openai: '#10a37f',
  'openai-codex': '#10a37f',
  google: '#4c8df6',
  'google-vertex': '#4c8df6',
  'google-gemini-cli': '#4c8df6',
  openrouter: '#8b7cf6',
  xai: '#a1a1aa',
  mistral: '#fa7a2a',
  deepseek: '#4d6bfe',
  'github-copilot': '#a1a1aa'
}

/**
 * UI name from the caller's engine catalog, else a readable form of the provider id. A session never
 * consults another engine's selected settings catalog for provider names.
 */
export function providerLabel(provider: string, providers?: ProviderInfo[]): string {
  return providerName(providers?.find((p) => p.id === provider) ?? { id: provider, name: provider })
}

/**
 * 14px provider letter tile (brand-tinted, neutral for unknown providers): identifies the provider on the model
 * pill and in group headings without reading as a live/recording dot.
 */
export function ProviderTile({ provider, className }: { provider: string; className?: string }) {
  const brand = PROVIDER_COLORS[provider]
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center rounded-xs text-[9px] leading-none font-semibold',
        !brand && 'bg-hover text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)]',
        className
      )}
      style={
        brand
          ? {
              background: `color-mix(in oklab, ${brand} 20%, transparent)`,
              color: `color-mix(in oklab, ${brand} 78%, var(--fg))`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${brand} 28%, transparent)`
            }
          : undefined
      }
    >
      {providerLabel(provider).charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * Selection caret inset inside the row's rounded fill (r4 item 8): 4px from the left edge, 6px from top and
 * bottom. Overrides the list row primitive's centered caret; tailwind-merge keeps these.
 */
export const insetCaretClass =
  'before:top-1.5 before:bottom-1.5 before:left-1 before:h-auto before:translate-y-0 before:rounded-[1px]'

const modelCache = new Map<string, Model[]>()

useAgents.subscribe((state, previous) => {
  if (state.order === previous.order) return
  for (const agentId of modelCache.keys()) {
    if (!state.agents[agentId]) modelCache.delete(agentId)
  }
})

// A sign-in, sign-out or models.json edit changes what the agents offer (they restart to pick it up).
on('settings:changed', ({ area }) => {
  if (area === 'auth' || area === 'models') modelCache.clear()
})
// The models an account offers changed (main filters the lists, the agents keep running).
on('settings:account-models', () => modelCache.clear())

function useAvailableModels(
  agentId: string,
  open: boolean
): { models: Model[] | null; error: string | null } {
  const generation = useAgents((state) => state.agents[agentId]?.engineGeneration)
  const [models, setModels] = useState<Model[] | null>(() => modelCache.get(agentId) ?? null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    setModels(modelCache.get(agentId) ?? null)
    setError(null)
    rpc(agentId, { type: 'get_available_models' })
      .then(({ models: list }) => {
        if (alive) {
          if (useAgents.getState().agents[agentId]?.engineGeneration !== generation) return
          modelCache.set(agentId, list)
          setModels(list)
          setError(null)
        }
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [agentId, generation, open])
  return { models, error }
}

export interface ModelRowProps {
  model: Model
  /** The model in use (selected row: active fill and inset caret). */
  active?: boolean
  /** `false` dims the row for a provider without working credentials. Default: ready. */
  ready?: boolean
  /** Short neutral tag after the name (e.g. "Default", "From extension"). */
  badge?: string
  onSelect?: () => void
}

/**
 * One model in a picker: name + id, reasoning/image capabilities, context window; the current model is the
 * selected row (active fill + inset caret, no extra check).
 * Renders a cmdk `Command.Item` (value `provider/id`, searchable by name, id and provider), so mount it inside a
 * `<Command>` list. Shared by the ModelPicker popover and the palette's Models page.
 */
export function ModelRow({ model, active = false, ready = true, badge, onSelect }: ModelRowProps) {
  return (
    <Command.Item
      value={`${model.provider}/${model.id}`}
      keywords={[
        model.name,
        model.id,
        `${model.provider}/${model.id}`,
        model.provider,
        providerLabel(model.provider)
      ]}
      onSelect={onSelect}
      className={cn(
        listRowClass({ density: 'rich', selected: active }),
        active && insetCaretClass,
        // cmdk marks every item data-disabled="false"; the list row primitive dims any data-disabled.
        'cursor-default data-[disabled=false]:pointer-events-auto',
        ready ? 'data-[disabled=false]:opacity-100' : 'opacity-55 data-[disabled=false]:opacity-55'
      )}
    >
      <ListRowContent
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'truncate',
                active ? 'font-medium text-fg' : 'text-fg-2 group-data-[selected=true]/row:text-fg'
              )}
            >
              {model.name}
            </span>
            {badge && <Badge className="font-medium">{badge}</Badge>}
          </span>
        }
        subtitle={
          <span className="font-mono text-[10.5px]">
            {model.id}
            {!ready && <span className="font-sans"> · not signed in</span>}
          </span>
        }
        meta={
          <span className="flex items-center gap-2 text-fg-3">
            {model.reasoning && <Brain className="size-3.5" aria-label="Reasoning" />}
            {model.input.includes('image') && (
              <ImageIcon className="size-3.5" aria-label="Image input" />
            )}
            <span className="w-10 text-right">{formatTokens(model.contextWindow)}</span>
          </span>
        }
      />
      {active && <span className="sr-only">Current model</span>}
    </Command.Item>
  )
}

export interface ModelPickerProps {
  agentId: string
  /** Custom trigger (rendered via asChild). Without it the picker shows its own model pill. */
  children?: ReactElement
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  /** Controlled open state (optional). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * The one model picker (SPEC §9.1): a searchable popover grouped by provider (`get_available_models` →
 * `set_model`). The composer footer mounts it on its model pill (`side="top"`); without `children` it renders
 * a built-in pill trigger.
 */
export function ModelPicker({
  agentId,
  children,
  side = 'bottom',
  align = 'end',
  open: controlledOpen,
  onOpenChange
}: ModelPickerProps) {
  const model = useAgents((s) => s.agents[agentId]?.model)
  const switching = useAgents((state) => state.agents[agentId]?.modelChangePending ?? false)
  const ready = useAgents((state) => state.agents[agentId]?.status === 'ready')
  const engine = useAgents((state) => state.agents[agentId]?.info.engine ?? 'pi')
  const cwd = useAgents((state) => state.agents[agentId]?.info.cwd ?? null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const { models, error } = useAvailableModels(agentId, open)
  const providers = useCatalogProviders(engine, cwd)
  const currentKey = model ? `${model.provider}/${model.id}` : ''
  // The highlighted row: the current model on every open, so Enter right away keeps it.
  const [highlighted, setHighlighted] = useState(currentKey)
  useEffect(() => {
    if (open) setHighlighted(currentKey)
  }, [open, currentKey])
  // cmdk scrolls the highlighted row into view only when it mounts with its rows; a fresh list arrives later.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || !models) return
    const frame = requestAnimationFrame(() =>
      listRef.current
        ?.querySelector('[cmdk-item][data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    )
    return () => cancelAnimationFrame(frame)
  }, [open, models])

  const groups = useMemo(() => {
    const map = new Map<string, Model[]>()
    for (const m of models ?? []) {
      const list = map.get(m.provider) ?? []
      list.push(m)
      map.set(m.provider, list)
    }
    return [...map.entries()]
  }, [models])

  const choose = async (next: Model) => {
    setOpen(false)
    if (!switching && model && next.provider === model.provider && next.id === model.id) return
    try {
      await useAgents.getState().setModel(agentId, next.provider, next.id)
    } catch (e) {
      toastFailure('Could not switch model', e)
    }
  }

  const trigger = children ?? (
    <button
      type="button"
      disabled={!ready}
      aria-busy={switching}
      data-state={open ? 'open' : 'closed'}
      className="no-drag inline-flex h-7 max-w-[220px] items-center gap-2 rounded-md px-2.5 text-sm text-fg-2 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
    >
      {switching ? (
        <Spinner size={11} />
      ) : model ? (
        <ProviderTile provider={model.provider} />
      ) : (
        <span className="size-3.5 rounded-xs bg-hover" />
      )}
      <span className="truncate font-medium">{model?.name ?? 'Choose a model'}</span>
      <ChevronDown className="size-3.5 shrink-0 text-fg-3" />
    </button>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align={align}
      sideOffset={8}
      className="w-[380px] p-0"
      trigger={trigger}
    >
      <Command
        label="Choose a model"
        loop
        value={highlighted}
        onValueChange={setHighlighted}
        className="flex max-h-[min(460px,70vh)] flex-col"
      >
        <div className="flex h-11 items-center gap-2.5 border-b border-hairline px-3.5">
          <Search className="size-4 shrink-0 text-fg-3" />
          <Command.Input
            autoFocus
            placeholder="Search models…"
            className="h-full min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-3"
          />
        </div>
        <Command.List ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {models === null && !error && (
            <Command.Loading>
              <div className="flex h-20 items-center justify-center text-fg-3">
                <Spinner />
              </div>
            </Command.Loading>
          )}
          {error && <div className="px-3 py-6 text-center text-sm text-danger">{error}</div>}
          <Command.Empty className="px-3 py-8 text-center text-sm text-fg-3">
            No models match.
          </Command.Empty>
          {groups.map(([provider, list]) => (
            <Command.Group
              key={provider}
              heading={
                <span className="flex items-center gap-2">
                  <ProviderTile provider={provider} />
                  {providerLabel(provider, providers)}
                </span>
              }
              className="mb-1 [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3"
            >
              {list.map((m) => (
                <ModelRow
                  key={`${m.provider}/${m.id}`}
                  model={m}
                  active={!!model && model.provider === m.provider && model.id === m.id}
                  onSelect={() => void choose(m)}
                />
              ))}
            </Command.Group>
          ))}
        </Command.List>
        <div className="flex h-8 items-center gap-3 border-t border-hairline px-3.5 text-2xs text-fg-3">
          <span className="flex items-center gap-1">
            <Brain className="size-3" /> Reasoning
          </span>
          <span className="flex items-center gap-1">
            <ImageIcon className="size-3" /> Images
          </span>
          <span className="ml-auto">Context window</span>
        </div>
      </Command>
    </Popover>
  )
}
