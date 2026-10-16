import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import type { Model } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import { selectActiveAgent, useAgents } from '../../store/agents'
import { listRowClass, ListRowContent, Spinner, toast } from '../../ui'
import type { ListRowClassOptions } from '../../ui/ListRow'
import {
  insetCaretClass,
  ModelRow,
  ProviderTile,
  providerLabel,
  useCatalogProviders
} from '../chat/ModelPicker'
import { ThinkingMeter } from '../chat/ThinkingControl'
import { THINKING_INFO, THINKING_LABELS } from '../composer/thinking-pill'
import { supportsEngineCommand, useEngineCapabilities } from '../engines/registry'

export const groupClass =
  '[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:h-7 [&_[cmdk-group-heading]]:items-end [&_[cmdk-group-heading]]:gap-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1.5 ' +
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-3'

/**
 * cmdk marks every item `data-disabled="false"`, which the shared row's `data-[disabled]:` dimming also matches;
 * the same-variant overrides replace it (tailwind-merge keeps the last of a conflicting pair).
 */
export function paletteRowClass(options: ListRowClassOptions): string {
  return cn(
    listRowClass(options),
    'cursor-default data-[disabled]:pointer-events-auto data-[disabled]:opacity-100'
  )
}

/** One model row: the shared chat ModelRow (the group heading carries the provider tile). */
function ModelItem({
  model,
  current,
  onSelect
}: {
  model: Model
  current: boolean
  onSelect(): void
}) {
  return <ModelRow model={model} active={current} onSelect={onSelect} />
}

/** `filtered`: a query is typed, so cmdk's best match stays highlighted instead of the current model. */
export function ModelsPage({
  onDone,
  highlight,
  filtered
}: {
  onDone(): void
  highlight(value: string): void
  filtered: boolean
}) {
  const activeId = useAgents((s) => s.activeAgentId)
  const engine = useAgents((state) =>
    activeId ? (state.agents[activeId]?.info.engine ?? 'pi') : 'pi'
  )
  const cwd = useAgents((state) => (activeId ? (state.agents[activeId]?.info.cwd ?? null) : null))
  const capabilities = useEngineCapabilities(engine)
  const current = useAgents((s) => (activeId ? s.agents[activeId]?.model : undefined))
  const [models, setModels] = useState<Model[] | null>(null)
  const providers = useCatalogProviders(engine, cwd)

  useEffect(() => {
    const model = selectActiveAgent(useAgents.getState())?.model
    if (models && model && !filtered) highlight(`${model.provider}/${model.id}`)
  }, [models, highlight, filtered])

  useEffect(() => {
    setModels(null)
    if (!activeId || !supportsEngineCommand(engine, 'get_available_models')) return
    let cancelled = false
    rpc(activeId, { type: 'get_available_models' })
      .then(({ models: list }) => !cancelled && setModels(list))
      .catch(() => !cancelled && setModels([]))
    return () => {
      cancelled = true
    }
  }, [activeId, engine, capabilities])

  if (!activeId)
    return (
      <div className="py-12 text-center text-sm text-fg-3">Open a session to choose its model.</div>
    )
  if (capabilities && !supportsEngineCommand(engine, 'set_model')) {
    return (
      <div className="py-12 text-center text-sm text-fg-3">
        This engine does not support model switching.
      </div>
    )
  }
  if (!models) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 text-sm text-fg-3">
        <Spinner /> Loading models…
      </div>
    )
  }
  const byProvider = new Map<string, Model[]>()
  for (const model of models)
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  return (
    <>
      {[...byProvider].map(([provider, list]) => (
        <Command.Group
          key={provider}
          heading={
            <>
              <ProviderTile provider={provider} />
              {providerLabel(provider, providers)}
            </>
          }
          className={groupClass}
        >
          {list.map((model) => (
            <ModelItem
              key={`${model.provider}/${model.id}`}
              model={model}
              current={current?.provider === model.provider && current.id === model.id}
              onSelect={() => {
                onDone()
                void useAgents
                  .getState()
                  .setModel(activeId, model.provider, model.id)
                  .then(() =>
                    toast({
                      level: 'info',
                      title: model.name,
                      description: `Now using ${providerLabel(model.provider)}`,
                      duration: 2200
                    })
                  )
                  .catch((error: Error) =>
                    toast({
                      level: 'error',
                      title: 'Could not switch model',
                      description: error.message
                    })
                  )
              }}
            />
          ))}
        </Command.Group>
      ))}
    </>
  )
}

export function ThinkingPage({
  onDone,
  highlight
}: {
  onDone(): void
  highlight(value: string): void
}) {
  const activeId = useAgents((s) => s.activeAgentId)
  const levels = useAgents((s) => (activeId ? s.agents[activeId]?.thinkingLevels : undefined)) ?? []
  const current = useAgents((s) => (activeId ? s.agents[activeId]?.thinkingLevel : undefined))

  useEffect(() => {
    const level = selectActiveAgent(useAgents.getState())?.thinkingLevel
    if (level) highlight(level)
  }, [highlight])
  if (!activeId) return null
  return (
    <Command.Group className={groupClass}>
      {levels.map((level) => (
        <Command.Item
          key={level}
          value={level}
          keywords={[THINKING_LABELS[level], THINKING_INFO[level]]}
          onSelect={() => {
            onDone()
            void useAgents
              .getState()
              .setThinkingLevel(activeId, level)
              .catch((error: Error) =>
                toast({
                  level: 'error',
                  title: 'Could not change the thinking level',
                  description: error.message
                })
              )
          }}
          className={cn(
            paletteRowClass({ density: 'list', selected: level === current }),
            level === current && insetCaretClass
          )}
        >
          <ListRowContent
            icon={
              <span className="flex w-6 justify-center">
                <ThinkingMeter level={level} />
              </span>
            }
            title={
              <span className="flex items-baseline gap-2.5">
                <span className="w-20 shrink-0 text-fg">{THINKING_LABELS[level]}</span>
                <span className="truncate text-sm font-normal text-fg-3">
                  {THINKING_INFO[level]}
                </span>
              </span>
            }
          />
        </Command.Item>
      ))}
    </Command.Group>
  )
}
