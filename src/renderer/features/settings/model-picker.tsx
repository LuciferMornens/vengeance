import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Command } from 'cmdk'
import { Brain, Check, ChevronsUpDown, ImageIcon, Lock, Search } from 'lucide-react'
import { Popover as RPopover } from 'radix-ui'
import type { ModelInfo } from '@shared/api/settings'
import { cn } from '../../lib/cn'
import { floatingSurface, Spinner } from '../../ui'
import { humanizeTokens } from './controls'
import { providerName } from './provider-name'
import { useSettings } from './store'

/** Searchable model picker over the engine's catalog (grouped by provider, availability-aware). */

export function modelKey(m: Pick<ModelInfo, 'provider' | 'id'>): string {
  return `${m.provider}/${m.id}`
}

export function useCatalog() {
  const engine = useSettings((state) => state.engine)
  const catalog = useSettings((s) => s.catalog)
  const loading = useSettings((s) => s.catalogLoading)
  const error = useSettings((state) => state.catalogError)
  const load = useSettings((s) => s.loadCatalog)
  useEffect(() => {
    void load()
  }, [engine, load])
  return { catalog, loading, error }
}

export function ModelLabel({
  model,
  fallback,
  className
}: {
  model?: ModelInfo
  fallback?: string
  className?: string
}) {
  const providers = useSettings((s) => s.catalog?.providers)
  const provider = providers?.find((p) => p.id === model?.provider)
  const providerLabel = provider ? providerName(provider) : model?.provider
  if (!model)
    return <span className={cn('truncate font-mono text-sm text-fg-2', className)}>{fallback}</span>
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)}>
      <span className="truncate text-ui text-fg">{model.name}</span>
      <span className="truncate text-xs text-fg-3">{providerLabel}</span>
    </span>
  )
}

export interface ModelPickerProps {
  value?: string
  onSelect: (model: ModelInfo) => void
  /** Custom trigger; defaults to a select-like button. */
  trigger?: ReactNode
  placeholder?: string
  disabled?: boolean
  /** Hide models whose provider has no credentials. */
  availableOnly?: boolean
  exclude?: Set<string>
  className?: string
}

export function ModelPicker({
  value,
  onSelect,
  trigger,
  placeholder = 'Choose a model…',
  disabled,
  availableOnly,
  exclude,
  className
}: ModelPickerProps) {
  const { catalog, loading } = useCatalog()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = useMemo(
    () => (value ? catalog?.models.find((m) => modelKey(m) === value) : undefined),
    [catalog, value]
  )

  const groups = useMemo(() => {
    if (!open || !catalog) return []
    const names = new Map(catalog.providers.map((p) => [p.id, providerName(p)]))
    const byProvider = new Map<string, ModelInfo[]>()
    for (const m of catalog.models) {
      if (availableOnly && !m.available) continue
      if (exclude?.has(modelKey(m))) continue
      const list = byProvider.get(m.provider) ?? []
      list.push(m)
      byProvider.set(m.provider, list)
    }
    return [...byProvider.entries()]
      .map(([provider, models]) => ({
        provider,
        name: names.get(provider) ?? provider,
        available: models.some((m) => m.available),
        models
      }))
      .sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name))
  }, [open, catalog, availableOnly, exclude])

  return (
    <RPopover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <RPopover.Trigger asChild disabled={disabled}>
        {trigger ?? (
          <button
            type="button"
            className={cn(
              'no-drag flex h-9 w-full items-center gap-2 rounded-md bg-surface-1 px-3 text-left shadow-[inset_0_0_0_1px_var(--hairline)]',
              'transition-shadow hover:shadow-[inset_0_0_0_1px_var(--hairline-strong)] disabled:opacity-45',
              className
            )}
          >
            <span className="min-w-0 flex-1">
              {value ? (
                <ModelLabel model={selected} fallback={value} />
              ) : (
                <span className="text-ui text-fg-3">{placeholder}</span>
              )}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-3" />
          </button>
        )}
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            floatingSurface,
            'w-[min(460px,var(--radix-popover-content-available-width))] p-0'
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command
            loop
            className="flex max-h-[380px] flex-col"
            filter={(itemValue, search) =>
              itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
            }
          >
            <div className="flex items-center gap-2 border-b border-hairline px-3">
              <Search className="size-3.5 text-fg-3" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search models…"
                className="h-10 flex-1 bg-transparent text-ui text-fg placeholder:text-fg-3"
              />
              {loading && <Spinner size={13} className="text-fg-3" />}
            </div>
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-3">
                {loading ? 'Loading models…' : 'No models match.'}
              </Command.Empty>
              {groups.map((group) => (
                <Command.Group
                  key={group.provider}
                  heading={
                    <span className="flex items-center gap-1.5">
                      {group.name}
                      {!group.available && <Lock className="size-3" />}
                    </span>
                  }
                  className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3"
                >
                  {group.models.map((m) => (
                    <Command.Item
                      key={modelKey(m)}
                      value={`${m.name} ${modelKey(m)} ${group.name}`}
                      onSelect={() => {
                        onSelect(m)
                        setOpen(false)
                      }}
                      className={cn(
                        'flex h-8 cursor-default items-center gap-2 rounded-md px-2.5 text-ui text-fg-2 data-[selected=true]:bg-hover data-[selected=true]:text-fg',
                        !m.available && 'text-fg-3'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      {m.fromExtension && (
                        <span
                          title="Registered by an extension in an open session"
                          className="rounded-xs bg-hover px-1.5 py-px text-2xs text-fg-3"
                        >
                          Extension
                        </span>
                      )}
                      {m.reasoning && <Brain className="size-3 text-fg-4" />}
                      {m.input.includes('image') && <ImageIcon className="size-3 text-fg-4" />}
                      <span className="tabular w-11 text-right text-xs text-fg-3">
                        {humanizeTokens(m.contextWindow) ?? m.contextWindow}
                      </span>
                      <Check
                        className={cn(
                          'size-3.5 text-fg-2',
                          modelKey(m) === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}
