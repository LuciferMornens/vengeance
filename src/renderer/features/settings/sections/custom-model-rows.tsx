import { useState } from 'react'
import { SlidersHorizontal, Trash2 } from 'lucide-react'
import type { JsonObject, JsonValue } from '@shared/api/settings'
import type { EngineId } from '@shared/api/engine'
import { cn } from '../../../lib/cn'
import { Button, IconButton, Input, Switch } from '../../../ui'
import { Collapse } from '../../../ui/Collapse'
import { NumberField, TextField } from '../controls'
import { useSettings } from '../store'
import { AdvancedModelFields } from './model-advanced'

export type ModelDraft = JsonObject

export function obj(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function withField(
  target: JsonObject,
  key: string,
  value: JsonValue | undefined
): JsonObject {
  const next = { ...target }
  if (value === undefined || value === '') delete next[key]
  else next[key] = value
  return next
}

/** Fields the advanced panel edits (model-advanced.tsx). */
const ADVANCED_KEYS = ['headers', 'compat', 'samplingParams']

export function hasAdvanced(target: JsonObject, engine: EngineId = 'pi', model = false): boolean {
  const keys =
    engine === 'prime'
      ? ['headers', 'compat', ...(model ? ['api', 'baseUrl', 'cost', 'thinkingLevelMap'] : [])]
      : ADVANCED_KEYS
  return keys.some((key) => target[key] !== undefined)
}

/**
 * Column template shared by the model and override grids and their headers. The text columns shrink
 * to `minmax(0,…)` so the fixed columns never squeeze a name field below its content; the number
 * columns fit a 7-digit token count.
 */
export const MODEL_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_88px_88px_auto_auto_auto_auto] gap-2 px-4'
const MODEL_GRID_NUMBER = '[&_input]:w-[88px]'

/** Toggle for a model's advanced panel; shows a dot when headers, compatibility or sampling are set. */
function AdvancedToggle({
  open,
  set,
  label,
  onToggle
}: {
  open: boolean
  set: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <IconButton
      label={label}
      size="sm"
      active={open}
      aria-expanded={open}
      onClick={onToggle}
      className="relative"
    >
      <SlidersHorizontal />
      {set && !open && (
        <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-fg-2" />
      )}
    </IconButton>
  )
}

export function ModelRow({
  model,
  api,
  onChange,
  onRemove
}: {
  model: ModelDraft
  api: string | undefined
  onChange: (next: ModelDraft) => void
  onRemove: () => void
}) {
  const engine = useSettings((state) => state.engine)
  const [advanced, setAdvanced] = useState(false)
  const input = Array.isArray(model.input) ? model.input : ['text']
  const label = typeof model.id === 'string' && model.id ? model.id : 'this model'
  return (
    <div className="border-b border-hairline-soft last:border-b-0">
      <div className={cn(MODEL_GRID, 'items-center py-2')}>
        <TextField
          mono
          value={typeof model.id === 'string' ? model.id : ''}
          placeholder="model-id"
          onCommit={(v) => onChange(withField(model, 'id', v))}
        />
        <TextField
          value={typeof model.name === 'string' ? model.name : undefined}
          placeholder="Display name"
          onCommit={(v) => onChange(withField(model, 'name', v))}
        />
        <NumberField
          aria-label="Context window"
          value={typeof model.contextWindow === 'number' ? model.contextWindow : undefined}
          placeholder={128000}
          integer
          min={1}
          showHint={false}
          className={MODEL_GRID_NUMBER}
          onCommit={(v) => onChange(withField(model, 'contextWindow', v))}
        />
        <NumberField
          aria-label="Max output tokens"
          value={typeof model.maxTokens === 'number' ? model.maxTokens : undefined}
          placeholder={16384}
          integer
          min={1}
          showHint={false}
          className={MODEL_GRID_NUMBER}
          onCommit={(v) => onChange(withField(model, 'maxTokens', v))}
        />
        <Switch
          aria-label="Reasoning"
          checked={model.reasoning === true}
          onCheckedChange={(on) => onChange(withField(model, 'reasoning', on || undefined))}
        />
        <Switch
          aria-label="Image input"
          checked={input.includes('image')}
          onCheckedChange={(on) =>
            onChange(withField(model, 'input', on ? ['text', 'image'] : undefined))
          }
        />
        <AdvancedToggle
          open={advanced}
          set={hasAdvanced(model, engine, true)}
          label={
            engine === 'prime'
              ? `Advanced model settings for ${label}`
              : `Headers, compatibility and sampling of ${label}`
          }
          onToggle={() => setAdvanced((v) => !v)}
        />
        <IconButton label="Remove model" size="sm" onClick={onRemove}>
          <Trash2 />
        </IconButton>
      </div>
      <Collapse open={advanced}>
        <div className="px-4 pt-1 pb-4">
          <AdvancedModelFields
            target={model}
            api={typeof model.api === 'string' ? model.api : api}
            kind="model"
            onChange={onChange}
          />
        </div>
      </Collapse>
    </div>
  )
}

/** Fields the override grid and its advanced panel edit; anything else in an override is kept and listed. */
const OVERRIDE_GRID_KEYS = [
  'name',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input',
  ...ADVANCED_KEYS
]

/**
 * `modelOverrides`: change metadata of built-in or extension models without replacing the provider's
 * model list (pi docs/models.md). Keyed by model id; unknown ids are ignored by the engine.
 */
export function ModelOverrides({
  providerId,
  overrides,
  onChange
}: {
  providerId: string
  overrides: JsonObject
  onChange: (next: JsonObject | undefined) => void
}) {
  const engine = useSettings((state) => state.engine)
  const catalog = useSettings((s) => s.catalog)
  const [newId, setNewId] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const known = (catalog?.models ?? []).filter((m) => m.provider === providerId)
  const entries = Object.entries(overrides).map(([modelId, raw]) => [modelId, obj(raw)] as const)
  const set = (modelId: string, next: JsonObject | undefined) => {
    const copy = { ...overrides }
    if (next === undefined) delete copy[modelId]
    else copy[modelId] = next
    onChange(Object.keys(copy).length ? copy : undefined)
  }
  const add = () => {
    const id = newId.trim()
    if (!id || id in overrides) return
    set(id, {})
    setNewId('')
  }
  const listId = `overrides-${providerId}`
  return (
    <div className="border-t border-hairline-soft">
      <div className="flex items-baseline gap-2 px-4 pt-3 pb-1.5">
        <span className="text-xs font-medium text-fg-3">Model overrides</span>
        <span className="text-xs text-fg-3">
          Change limits or names of existing models without redefining them.
        </span>
      </div>
      {entries.length > 0 && (
        <div className={cn(MODEL_GRID, 'pt-1 text-xs font-medium text-fg-3')}>
          <span>Model</span>
          <span>Name</span>
          <span>Context</span>
          <span>Max output</span>
          <span className="w-8 text-center">Think</span>
          <span className="w-8 text-center">Image</span>
          <span className="w-7" />
          <span className="w-7" />
        </div>
      )}
      {entries.map(([modelId, override]) => {
        const base = known.find((m) => m.id === modelId)
        const extra = Object.keys(override).filter(
          (key) =>
            !OVERRIDE_GRID_KEYS.includes(key) &&
            !(engine === 'prime' && ['cost', 'thinkingLevelMap'].includes(key))
        )
        const input = Array.isArray(override.input) ? override.input : undefined
        const baseImage = !!base?.input.includes('image')
        return (
          <div key={modelId}>
            <div className={cn(MODEL_GRID, 'items-center py-2')}>
              <div className="min-w-0">
                <div className="truncate font-mono text-sm text-fg">{modelId}</div>
                <div className="truncate text-xs text-fg-3">
                  {base ? base.name : 'Not in the catalog'}
                  {extra.length > 0 && ` · also ${extra.join(', ')}`}
                </div>
              </div>
              <TextField
                value={typeof override.name === 'string' ? override.name : undefined}
                placeholder={base?.name ?? 'Display name'}
                onCommit={(v) => set(modelId, withField(override, 'name', v))}
              />
              <NumberField
                aria-label={`Context window of ${modelId}`}
                value={
                  typeof override.contextWindow === 'number' ? override.contextWindow : undefined
                }
                placeholder={base?.contextWindow}
                integer
                min={1}
                showHint={false}
                className={MODEL_GRID_NUMBER}
                onCommit={(v) => set(modelId, withField(override, 'contextWindow', v))}
              />
              <NumberField
                aria-label={`Max output tokens of ${modelId}`}
                value={typeof override.maxTokens === 'number' ? override.maxTokens : undefined}
                placeholder={base?.maxTokens}
                integer
                min={1}
                showHint={false}
                className={MODEL_GRID_NUMBER}
                onCommit={(v) => set(modelId, withField(override, 'maxTokens', v))}
              />
              <Switch
                aria-label={`Reasoning for ${modelId}`}
                checked={
                  typeof override.reasoning === 'boolean' ? override.reasoning : !!base?.reasoning
                }
                onCheckedChange={(on) =>
                  set(
                    modelId,
                    withField(override, 'reasoning', on === !!base?.reasoning ? undefined : on)
                  )
                }
              />
              <Switch
                aria-label={`Image input for ${modelId}`}
                checked={input ? input.includes('image') : baseImage}
                onCheckedChange={(on) =>
                  set(
                    modelId,
                    withField(
                      override,
                      'input',
                      on === baseImage ? undefined : on ? ['text', 'image'] : ['text']
                    )
                  )
                }
              />
              <AdvancedToggle
                open={expanded === modelId}
                set={hasAdvanced(override, engine, true)}
                label={
                  engine === 'prime'
                    ? `Advanced model settings for ${modelId}`
                    : `Headers, compatibility and sampling of ${modelId}`
                }
                onToggle={() => setExpanded((current) => (current === modelId ? null : modelId))}
              />
              <IconButton
                label={`Remove override for ${modelId}`}
                size="sm"
                onClick={() => set(modelId, undefined)}
              >
                <Trash2 />
              </IconButton>
            </div>
            <Collapse open={expanded === modelId}>
              <div className="px-4 pt-1 pb-4">
                <AdvancedModelFields
                  target={override}
                  api={base?.api}
                  kind="override"
                  onChange={(next) => set(modelId, next)}
                />
              </div>
            </Collapse>
          </div>
        )
      })}
      <div className="flex items-center gap-2 px-3 py-2">
        <Input
          list={listId}
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Model id to override"
          spellCheck={false}
          className="h-7 w-64 bg-surface-1 font-mono text-xs"
        />
        <datalist id={listId}>
          {known
            .filter((m) => !(m.id in overrides))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </datalist>
        <Button
          size="sm"
          variant="ghost"
          leading={<SlidersHorizontal />}
          disabled={!newId.trim() || newId.trim() in overrides}
          onClick={add}
        >
          Add override
        </Button>
      </div>
    </div>
  )
}
