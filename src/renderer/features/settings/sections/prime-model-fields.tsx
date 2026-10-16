import { useId, useState, type ReactNode } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import { MODEL_API_TYPES, type JsonObject, type JsonValue } from '@shared/api/settings'
import { Button, IconButton, Input, SegmentedControl, Select } from '../../../ui'
import { ListEditor, NumberField } from '../controls'

interface PrimeFieldsProps {
  target: JsonObject
  onChange(next: JsonObject): void
}

interface PrimeModelFieldsProps extends PrimeFieldsProps {
  allowEndpoint?: boolean
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function withField(target: JsonObject, key: string, value: JsonValue | undefined): JsonObject {
  const next = { ...target }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

function withObject(target: JsonObject, key: string, value: JsonObject): JsonObject {
  return withField(target, key, Object.keys(value).length ? value : undefined)
}

function Field({
  label,
  hint,
  onReset,
  children
}: {
  label: string
  hint?: string
  onReset?: () => void
  children: ReactNode
}) {
  const labelId = useId()
  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0 space-y-2">
      <div className="flex items-center gap-2">
        <span id={labelId} className="text-xs font-medium text-fg-2">
          {label}
        </span>
        {onReset && (
          <IconButton
            label={`Reset ${label.toLowerCase()} to inherited`}
            size="sm"
            onClick={onReset}
          >
            <RotateCcw />
          </IconButton>
        )}
      </div>
      {hint && <p className="text-xs leading-relaxed text-fg-3">{hint}</p>}
      {children}
    </div>
  )
}

function TextValue({
  label,
  value,
  placeholder,
  keepEmpty = false,
  onChange
}: {
  label: string
  value: JsonValue | undefined
  placeholder?: string
  keepEmpty?: boolean
  onChange(value: string | undefined): void
}) {
  return (
    <Input
      aria-label={label}
      spellCheck={false}
      value={typeof value === 'string' ? value : ''}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value || (keepEmpty ? '' : undefined))}
    />
  )
}

function ThinkingLevelMap({ target, onChange }: PrimeFieldsProps) {
  const [newLevel, setNewLevel] = useState('')
  const mapping = objectValue(target.thinkingLevelMap)
  const level = newLevel.trim()
  const duplicate = Object.hasOwn(mapping, level)
  const put = (name: string, value: JsonValue | undefined) => {
    onChange(withObject(target, 'thinkingLevelMap', withField(mapping, name, value)))
  }
  const add = () => {
    if (!level || duplicate) return
    put(level, '')
    setNewLevel('')
  }
  return (
    <Field
      label="Thinking level mapping"
      hint="Map a thinking level to the provider's value, or mark it unavailable with null. Unset levels inherit the engine mapping."
    >
      <div className="space-y-2">
        {Object.entries(mapping).map(([name, value]) => (
          <div key={name} className="flex flex-wrap items-center gap-2">
            <span className="w-24 truncate text-sm text-fg-2" title={name}>
              {name}
            </span>
            <Select
              size="sm"
              value={value === null ? 'null' : 'value'}
              onValueChange={(mode) => put(name, mode === 'null' ? null : '')}
              options={[
                { value: 'value', label: 'Provider value' },
                { value: 'null', label: 'Unavailable (null)' }
              ]}
            />
            {value !== null && (
              <div className="min-w-32 flex-1">
                <TextValue
                  label={`Provider value for ${name}`}
                  value={value}
                  keepEmpty
                  onChange={(next) => put(name, next ?? '')}
                />
              </div>
            )}
            <IconButton
              size="sm"
              label={`Remove mapping for ${name}`}
              onClick={() => put(name, undefined)}
            >
              <X />
            </IconButton>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="New thinking level"
            placeholder="Thinking level, e.g. high"
            value={newLevel}
            className="min-w-40 flex-1"
            aria-invalid={duplicate || undefined}
            onChange={(event) => setNewLevel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            leading={<Plus />}
            disabled={!level || duplicate}
            onClick={add}
          >
            Add mapping
          </Button>
        </div>
        {duplicate && <p className="text-xs text-danger">This level already has a mapping.</p>}
      </div>
    </Field>
  )
}

const MODEL_COST_FIELDS = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' }
]

const API_INHERITED = '__inherited__'
const NATIVE_API_OPTIONS = [
  { value: API_INHERITED, label: 'Inherit from provider' },
  ...MODEL_API_TYPES.filter((api) => api !== 'pi-messages').map((api) => ({
    value: api,
    label: api
  }))
]

export function PrimeModelFields({
  target,
  onChange,
  allowEndpoint = false
}: PrimeModelFieldsProps) {
  const cost = objectValue(target.cost)
  const api = typeof target.api === 'string' ? target.api : API_INHERITED
  const supportedApi = NATIVE_API_OPTIONS.some((option) => option.value === api)
  return (
    <div className="space-y-5">
      {allowEndpoint && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Model API">
            <Select
              value={supportedApi ? api : undefined}
              placeholder="Unsupported saved API"
              options={NATIVE_API_OPTIONS}
              onValueChange={(next) =>
                onChange(withField(target, 'api', next === API_INHERITED ? undefined : next))
              }
            />
          </Field>
          <Field label="Model base URL" hint="Leave empty to inherit the provider URL.">
            <TextValue
              label="Model base URL"
              value={target.baseUrl}
              placeholder="https://…"
              onChange={(next) => onChange(withField(target, 'baseUrl', next))}
            />
          </Field>
        </div>
      )}
      <ThinkingLevelMap target={target} onChange={onChange} />
      <Field
        label="Token costs"
        hint="US dollars per million tokens. Leave values empty to use the engine's defaults."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {MODEL_COST_FIELDS.map((field) => (
            <label key={field.key} className="space-y-1.5">
              <span className="block text-xs text-fg-3">{field.label}</span>
              <NumberField
                aria-label={`${field.label} cost per million tokens`}
                value={numberValue(cost[field.key])}
                placeholder="Inherited"
                onCommit={(next) =>
                  onChange(withObject(target, 'cost', withField(cost, field.key, next)))
                }
              />
            </label>
          ))}
        </div>
      </Field>
    </div>
  )
}

const ROUTING_FLAGS = [
  { key: 'allowFallbacks', label: 'Allow fallback providers' },
  { key: 'requireParameters', label: 'Require all request parameters' },
  { key: 'zdr', label: 'Zero data retention' },
  { key: 'enforceDistillableText', label: 'Require distillable text' }
]

const OPENROUTER_LISTS = [
  { key: 'order', label: 'Preferred provider order' },
  { key: 'only', label: 'Allowed providers' },
  { key: 'ignore', label: 'Excluded providers' },
  { key: 'quantizations', label: 'Allowed quantizations' }
]

const BOOLEAN_OPTIONS = [
  { value: 'inherited', label: 'Inherit' },
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' }
]

function RoutingLists({
  target,
  onChange,
  fields
}: PrimeFieldsProps & { fields: readonly { key: string; label: string }[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map(({ key, label }) => {
        const value = target[key]
        return (
          <Field
            key={key}
            label={label}
            onReset={
              value !== undefined ? () => onChange(withField(target, key, undefined)) : undefined
            }
          >
            <ListEditor
              value={
                Array.isArray(value)
                  ? value.filter((item): item is string => typeof item === 'string')
                  : []
              }
              placeholder="Add value…"
              onChange={(next) => onChange(withField(target, key, next))}
            />
          </Field>
        )
      })}
    </div>
  )
}

function RoutingSort({ target, onChange }: PrimeFieldsProps) {
  const value = target.sort
  const mode =
    typeof value === 'string'
      ? 'metric'
      : value && typeof value === 'object'
        ? 'detailed'
        : 'inherited'
  const detailed = objectValue(value)
  const put = (next: JsonValue | undefined) => onChange(withField(target, 'sort', next))
  return (
    <Field label="Provider sorting">
      <Select
        value={mode}
        options={[
          { value: 'inherited', label: 'Inherit' },
          { value: 'metric', label: 'Single metric' },
          { value: 'detailed', label: 'Metric and partition' }
        ]}
        onValueChange={(next) => {
          if (next === 'inherited') put(undefined)
          else if (next === 'metric')
            put(
              typeof value === 'string' ? value : typeof detailed.by === 'string' ? detailed.by : ''
            )
          else put(typeof value === 'string' ? { by: value } : detailed)
        }}
      />
      {mode === 'metric' && (
        <TextValue label="Sorting metric" value={value} keepEmpty onChange={put} />
      )}
      {mode === 'detailed' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sort metric">
            <TextValue
              label="Sort metric"
              value={detailed.by}
              onChange={(next) => put(withField(detailed, 'by', next))}
            />
          </Field>
          <Field label="Partition">
            <TextValue
              label="Sort partition"
              value={detailed.partition}
              onChange={(next) => put(withField(detailed, 'partition', next))}
            />
          </Field>
        </div>
      )}
    </Field>
  )
}

const PRICE_FIELDS = ['prompt', 'completion', 'image', 'audio', 'request']

function RoutingPrices({ target, onChange }: PrimeFieldsProps) {
  const prices = objectValue(target.maxPrice)
  const put = (key: string, value: JsonValue | undefined) => {
    onChange(withObject(target, 'maxPrice', withField(prices, key, value)))
  }
  return (
    <Field
      label="Maximum prices"
      hint="Set an optional cap using the provider's numeric or text representation."
    >
      <div className="space-y-2">
        {PRICE_FIELDS.map((key) => {
          const value = prices[key]
          const mode =
            typeof value === 'number'
              ? 'number'
              : typeof value === 'string'
                ? 'string'
                : 'inherited'
          return (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-xs capitalize text-fg-2">{key}</span>
              <Select
                size="sm"
                value={mode}
                options={[
                  { value: 'inherited', label: 'Inherit' },
                  { value: 'number', label: 'Number' },
                  { value: 'string', label: 'Text' }
                ]}
                onValueChange={(next) => {
                  if (next === 'inherited') put(key, undefined)
                  else if (next === 'number')
                    put(key, Number.isFinite(Number(value)) ? Number(value) : 0)
                  else put(key, value === undefined ? '' : String(value))
                }}
              />
              {mode === 'number' && (
                <NumberField
                  aria-label={`Maximum ${key} price`}
                  value={typeof value === 'number' ? value : undefined}
                  onCommit={(next) => put(key, next)}
                />
              )}
              {mode === 'string' && (
                <div className="min-w-32 flex-1">
                  <TextValue
                    label={`Maximum ${key} price text`}
                    value={value}
                    keepEmpty
                    onChange={(next) => put(key, next ?? '')}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Field>
  )
}

const PERCENTILES = ['p50', 'p75', 'p90', 'p99']

function RoutingThreshold({
  label,
  value,
  onChange
}: {
  label: string
  value: JsonValue | undefined
  onChange(value: JsonValue | undefined): void
}) {
  const mode =
    typeof value === 'number'
      ? 'scalar'
      : value && typeof value === 'object'
        ? 'percentiles'
        : 'inherited'
  const percentiles = objectValue(value)
  return (
    <Field label={label}>
      <Select
        value={mode}
        options={[
          { value: 'inherited', label: 'Inherit' },
          { value: 'scalar', label: 'Single threshold' },
          { value: 'percentiles', label: 'Per percentile' }
        ]}
        onValueChange={(next) => {
          if (next === 'inherited') onChange(undefined)
          else if (next === 'scalar') onChange(typeof value === 'number' ? value : 0)
          else onChange(percentiles)
        }}
      />
      {mode === 'scalar' && (
        <NumberField
          aria-label={label}
          value={typeof value === 'number' ? value : undefined}
          onCommit={onChange}
        />
      )}
      {mode === 'percentiles' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {PERCENTILES.map((key) => (
            <label key={key} className="space-y-1.5">
              <span className="block text-xs text-fg-3">{key}</span>
              <NumberField
                aria-label={`${label} ${key}`}
                value={typeof percentiles[key] === 'number' ? percentiles[key] : undefined}
                placeholder="Inherited"
                onCommit={(next) => onChange(withField(percentiles, key, next))}
              />
            </label>
          ))}
        </div>
      )}
    </Field>
  )
}

function RoutingSection({
  title,
  configured,
  children
}: {
  title: string
  configured: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(configured)
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="border-t border-hairline-soft pt-3"
    >
      <summary className="cursor-pointer text-sm font-medium text-fg-2">{title}</summary>
      <div className="space-y-5 pt-4">{children}</div>
    </details>
  )
}

export function PrimeRoutingFields({ target, onChange }: PrimeFieldsProps) {
  const routing = objectValue(target.openRouterRouting)
  const gateway = objectValue(target.vercelGatewayRouting)
  const putRouting = (next: JsonObject) => onChange(withObject(target, 'openRouterRouting', next))
  const putGateway = (next: JsonObject) =>
    onChange(withObject(target, 'vercelGatewayRouting', next))
  const put = (key: string, value: JsonValue | undefined) =>
    putRouting(withField(routing, key, value))
  return (
    <div className="space-y-4">
      <RoutingSection title="OpenRouter routing" configured={Object.keys(routing).length > 0}>
        <div className="grid gap-4 sm:grid-cols-2">
          {ROUTING_FLAGS.map(({ key, label }) => (
            <Field key={key} label={label}>
              <SegmentedControl
                size="sm"
                value={typeof routing[key] === 'boolean' ? String(routing[key]) : 'inherited'}
                segments={BOOLEAN_OPTIONS}
                onValueChange={(next) =>
                  put(key, next === 'inherited' ? undefined : next === 'true')
                }
              />
            </Field>
          ))}
          <Field label="Data collection">
            <Select
              value={
                typeof routing.dataCollection === 'string' ? routing.dataCollection : 'inherited'
              }
              options={[
                { value: 'inherited', label: 'Inherit' },
                { value: 'deny', label: 'Deny' },
                { value: 'allow', label: 'Allow' }
              ]}
              onValueChange={(next) =>
                put('dataCollection', next === 'inherited' ? undefined : next)
              }
            />
          </Field>
        </div>
        <RoutingLists target={routing} onChange={putRouting} fields={OPENROUTER_LISTS} />
        <RoutingSort target={routing} onChange={putRouting} />
        <RoutingPrices target={routing} onChange={putRouting} />
        <div className="grid gap-5 sm:grid-cols-2">
          <RoutingThreshold
            label="Preferred minimum throughput"
            value={routing.preferredMinThroughput}
            onChange={(next) => put('preferredMinThroughput', next)}
          />
          <RoutingThreshold
            label="Preferred maximum latency"
            value={routing.preferredMaxLatency}
            onChange={(next) => put('preferredMaxLatency', next)}
          />
        </div>
      </RoutingSection>
      <RoutingSection title="Vercel gateway routing" configured={Object.keys(gateway).length > 0}>
        <RoutingLists
          target={gateway}
          onChange={putGateway}
          fields={OPENROUTER_LISTS.filter((field) => field.key === 'only' || field.key === 'order')}
        />
      </RoutingSection>
    </div>
  )
}
