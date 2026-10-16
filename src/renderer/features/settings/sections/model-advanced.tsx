import type { ReactNode } from 'react'
import type { EngineId } from '@shared/api/engine'
import type { JsonObject, JsonValue } from '@shared/api/settings'
import { Plus, X } from 'lucide-react'
import { DropdownMenu, IconButton, SegmentedControl, Select } from '../../../ui'
import { KeyValueEditor } from '../controls'
import { useSettings } from '../store'
import { PrimeModelFields, PrimeRoutingFields } from './prime-model-fields'

/**
 * Visual editors for the advanced models.json fields of a provider, custom model or model override:
 * Headers, compatibility and model metadata follow each engine's schema.
 * Unknown keys stay untouched.
 */

type CompatField =
  | { key: string; label: string; hint: string; kind: 'switch' }
  | { key: string; label: string; hint: string; kind: 'choice'; options: string[] }

const OPENAI_COMPLETIONS_COMPAT: CompatField[] = [
  {
    key: 'supportsDeveloperRole',
    label: 'Developer role',
    hint: 'Send instructions with the developer role instead of system.',
    kind: 'switch'
  },
  {
    key: 'supportsReasoningEffort',
    label: 'Reasoning effort',
    hint: 'The endpoint accepts reasoning_effort.',
    kind: 'switch'
  },
  {
    key: 'supportsUsageInStreaming',
    label: 'Usage while streaming',
    hint: 'Token usage arrives in streamed responses.',
    kind: 'switch'
  },
  {
    key: 'supportsFinishReason',
    label: 'Finish reason',
    hint: 'Streamed responses include finish_reason.',
    kind: 'switch'
  },
  {
    key: 'supportsStore',
    label: 'Store field',
    hint: 'The endpoint accepts the store field.',
    kind: 'switch'
  },
  {
    key: 'supportsStrictMode',
    label: 'Strict tool schemas',
    hint: 'Tool definitions may set strict.',
    kind: 'switch'
  },
  {
    key: 'requiresToolResultName',
    label: 'Name on tool results',
    hint: 'Tool results must carry the tool name.',
    kind: 'switch'
  },
  {
    key: 'requiresAssistantAfterToolResult',
    label: 'Assistant turn after tools',
    hint: 'A user message after tool results needs an assistant message in between.',
    kind: 'switch'
  },
  {
    key: 'requiresThinkingAsText',
    label: 'Thinking as text',
    hint: 'Replay thinking as text wrapped in <thinking> tags.',
    kind: 'switch'
  },
  {
    key: 'maxTokensField',
    label: 'Max tokens field',
    hint: 'Request field that caps the answer length.',
    kind: 'choice',
    options: ['max_completion_tokens', 'max_tokens']
  },
  {
    key: 'thinkingFormat',
    label: 'Thinking format',
    hint: 'How the thinking level is sent.',
    kind: 'choice',
    options: [
      'openai',
      'openrouter',
      'deepseek',
      'together',
      'baseten',
      'zai',
      'qwen',
      'chat-template',
      'qwen-chat-template',
      'string-thinking',
      'ant-ling'
    ]
  }
]

const OPENAI_RESPONSES_COMPAT: CompatField[] = [
  {
    key: 'supportsDeveloperRole',
    label: 'Developer role',
    hint: 'Send instructions with the developer role instead of system.',
    kind: 'switch'
  },
  {
    key: 'supportsStrictMode',
    label: 'Strict tool schemas',
    hint: 'Tool definitions may set strict.',
    kind: 'switch'
  },
  {
    key: 'supportsMaxOutputTokens',
    label: 'Max output tokens',
    hint: 'The endpoint accepts max_output_tokens.',
    kind: 'switch'
  },
  {
    key: 'supportsLongCacheRetention',
    label: 'Long cache retention',
    hint: 'The endpoint accepts 24-hour prompt cache retention.',
    kind: 'switch'
  },
  {
    key: 'supportsMidConvoEffort',
    label: 'Keep cache when thinking changes',
    hint: 'Send effort changes inside the conversation. Ignored with ChatGPT sign-in.',
    kind: 'switch'
  }
]

const ANTHROPIC_COMPAT: CompatField[] = [
  {
    key: 'supportsTemperature',
    label: 'Temperature',
    hint: 'The endpoint accepts temperature.',
    kind: 'switch'
  },
  {
    key: 'supportsStrictTools',
    label: 'Strict tools',
    hint: 'Tool definitions may set strict.',
    kind: 'switch'
  },
  {
    key: 'supportsCacheControlOnTools',
    label: 'Cache control on tools',
    hint: 'Tool definitions may carry cache_control markers.',
    kind: 'switch'
  },
  {
    key: 'supportsLongCacheRetention',
    label: 'Long cache retention',
    hint: 'The endpoint accepts the one-hour cache TTL.',
    kind: 'switch'
  },
  {
    key: 'supportsEagerToolInputStreaming',
    label: 'Eager tool input streaming',
    hint: 'Tool arguments stream before they are complete.',
    kind: 'switch'
  }
]

const PRIME_COMPLETIONS_COMPAT: CompatField[] = [
  ...OPENAI_COMPLETIONS_COMPAT.filter((field) => field.key !== 'supportsFinishReason').map(
    (field): CompatField =>
      field.key === 'thinkingFormat'
        ? {
            ...field,
            kind: 'choice',
            options: ['openai', 'openrouter', 'deepseek', 'zai', 'qwen', 'qwen-chat-template']
          }
        : field
  ),
  {
    key: 'requiresReasoningContentOnAssistantMessages',
    label: 'Reasoning content on replies',
    hint: 'Include reasoning_content when replaying assistant messages.',
    kind: 'switch'
  },
  {
    key: 'zaiToolStream',
    label: 'Z.ai tool streaming',
    hint: 'Use the provider’s tool streaming format.',
    kind: 'switch'
  },
  {
    key: 'cacheControlFormat',
    label: 'Cache control format',
    hint: 'Format used for request cache markers.',
    kind: 'choice',
    options: ['anthropic']
  },
  {
    key: 'sendSessionAffinityHeaders',
    label: 'Session affinity headers',
    hint: 'Keep requests for a session routed together.',
    kind: 'switch'
  },
  {
    key: 'supportsLongCacheRetention',
    label: 'Long cache retention',
    hint: 'The endpoint accepts extended prompt cache retention.',
    kind: 'switch'
  }
]

const PRIME_RESPONSES_COMPAT: CompatField[] = [
  {
    key: 'sendSessionIdHeader',
    label: 'Session ID header',
    hint: 'Include the session identifier with each request.',
    kind: 'switch'
  },
  ...OPENAI_RESPONSES_COMPAT.filter((field) => field.key === 'supportsLongCacheRetention')
]

/** Compatibility switches of a wire protocol. Unset `api` means OpenAI completions. */
function compatFields(api: string | undefined, engine: EngineId): CompatField[] {
  if (engine === 'prime') {
    if (!api || api === 'openai-completions') return PRIME_COMPLETIONS_COMPAT
    if (['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(api))
      return PRIME_RESPONSES_COMPAT
    if (api === 'anthropic-messages')
      return ANTHROPIC_COMPAT.filter(
        (field) =>
          field.key === 'supportsEagerToolInputStreaming' ||
          field.key === 'supportsLongCacheRetention'
      )
    return []
  }
  if (!api || api === 'openai-completions') return OPENAI_COMPLETIONS_COMPAT
  if (api === 'openai-responses') return OPENAI_RESPONSES_COMPAT
  if (api === 'azure-openai-responses')
    return OPENAI_RESPONSES_COMPAT.filter((field) => field.key !== 'supportsMidConvoEffort')
  if (api === 'anthropic-messages') return ANTHROPIC_COMPAT
  return []
}

/** `samplingParams` and its per-level overrides only reach these protocols. */
const SAMPLING_APIS = ['openai-completions', 'openai-responses', 'azure-openai-responses']

function record(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** `target` with `key` set to `next`, or without `key` when `next` is empty. */
function withObject(target: JsonObject, key: string, next: JsonObject): JsonObject {
  const copy = { ...target }
  if (Object.keys(next).length) copy[key] = next
  else delete copy[key]
  return copy
}

function CompatRow({
  field,
  value,
  onChange,
  onRemove
}: {
  field: CompatField
  value: JsonValue | undefined
  onChange: (next: JsonValue) => void
  onRemove: () => void
}) {
  return (
    <div
      className="flex min-h-10 items-center gap-3 border-b border-hairline-soft
        py-1.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-fg">{field.label}</div>
        <div className="truncate text-xs text-fg-3" title={field.hint}>
          {field.hint}
        </div>
      </div>
      {field.kind === 'switch' ? (
        <SegmentedControl
          size="sm"
          aria-label={field.label}
          value={value === false ? 'off' : 'on'}
          onValueChange={(next) => onChange(next === 'on')}
          segments={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' }
          ]}
        />
      ) : (
        <Select
          size="sm"
          className="w-48 font-mono text-xs"
          value={typeof value === 'string' ? value : field.options[0]}
          onValueChange={onChange}
          options={field.options.map((option) => ({ value: option, label: option }))}
        />
      )}
      <IconButton
        label={`Back to automatic ${field.label.toLowerCase()}`}
        size="sm"
        onClick={onRemove}
      >
        <X />
      </IconButton>
    </div>
  )
}

/** Set switches show as rows; "Add setting" offers the automatic ones. */
function CompatEditor({
  engine,
  api,
  value,
  onChange
}: {
  engine: EngineId
  api: string | undefined
  value: JsonObject
  onChange: (next: JsonObject) => void
}) {
  const fields = compatFields(api, engine)
  const setFields = fields.filter((f) => value[f.key] !== undefined)
  const unset = fields.filter((f) => value[f.key] === undefined)
  const others = Object.keys(value).filter(
    (key) =>
      !fields.some((field) => field.key === key) &&
      !(
        engine === 'prime' &&
        (!api || api === 'openai-completions') &&
        ['openRouterRouting', 'vercelGatewayRouting'].includes(key)
      )
  )
  const put = (key: string, next: JsonValue | undefined) => {
    const copy = { ...value }
    if (next === undefined) delete copy[key]
    else copy[key] = next
    onChange(copy)
  }
  return (
    <div>
      {setFields.map((field) => (
        <CompatRow
          key={field.key}
          field={field}
          value={value[field.key]}
          onChange={(next) => put(field.key, next)}
          onRemove={() => put(field.key, undefined)}
        />
      ))}
      {others.length > 0 && (
        <p className="py-2 text-xs text-fg-3">Also set in JSON: {others.join(', ')}</p>
      )}
      {unset.length > 0 && (
        <DropdownMenu
          trigger={
            <button
              type="button"
              className="mt-1 flex h-7 items-center gap-1.5 rounded-md px-2 text-sm
                text-fg-3 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5"
            >
              <Plus />
              Add setting
            </button>
          }
          items={unset.map((field) => ({
            label: field.label,
            onSelect: () => put(field.key, field.kind === 'switch' ? true : field.options[0])
          }))}
        />
      )}
    </div>
  )
}

/** Numbers, booleans and JSON round-trip from sampling text back to their type. */
function samplingText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function samplingValue(text: string): JsonValue {
  const trimmed = text.trim()
  if (trimmed !== '' && String(Number(trimmed)) === trimmed) return Number(trimmed)
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true'
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed) as JsonValue
      if (JSON.stringify(parsed) === trimmed) return parsed
    } catch {
      // Not JSON yet (still typing): keep the text.
    }
  }
  return text
}

function Block({
  title,
  hint,
  children
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-xs font-medium text-fg-2">{title}</span>
        {hint && <span className="min-w-0 truncate text-xs text-fg-3">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

export interface AdvancedModelFieldsProps {
  /** A provider entry, a custom model or a model override. */
  target: JsonObject
  /** Wire protocol for compatibility switches; undefined means OpenAI completions. */
  api: string | undefined
  kind?: 'provider' | 'model' | 'override'
  onChange: (next: JsonObject) => void
}

/** Headers, compatibility and (for models) sampling defaults, edited in place on `target`. */
export function AdvancedModelFields({
  target,
  api,
  kind = 'provider',
  onChange
}: AdvancedModelFieldsProps) {
  const engine = useSettings((state) => state.engine)
  const headers = Object.fromEntries(
    Object.entries(record(target.headers)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  const params = record(target.samplingParams)
  const hasCompat = compatFields(api, engine).length > 0
  return (
    <div className="space-y-4">
      <Block
        title="Request headers"
        hint={
          engine === 'prime'
            ? 'Sent with every request. Values can use an environment variable name or !command.'
            : 'Sent with every request. Values can use $VAR or !command.'
        }
      >
        <KeyValueEditor
          value={headers}
          keyPlaceholder="Header-Name"
          valuePlaceholder={
            engine === 'prime' ? 'value, ENV_VAR or !command' : 'value, $VAR or !command'
          }
          addLabel="Add header"
          onChange={(next) => onChange(withObject(target, 'headers', next))}
        />
      </Block>
      {kind !== 'provider' && engine === 'prime' && (
        <PrimeModelFields target={target} onChange={onChange} allowEndpoint={kind === 'model'} />
      )}
      {hasCompat && (
        <Block
          title="Compatibility"
          hint="Detected from the URL. Set only differences you have verified."
        >
          <CompatEditor
            engine={engine}
            api={api}
            value={record(target.compat)}
            onChange={(next) => onChange(withObject(target, 'compat', next))}
          />
        </Block>
      )}
      {engine === 'prime' && (!api || api === 'openai-completions') && (
        <PrimeRoutingFields
          target={record(target.compat)}
          onChange={(next) => onChange(withObject(target, 'compat', next))}
        />
      )}
      {kind !== 'provider' && engine === 'pi' && (
        <Block
          title="Sampling defaults"
          hint={
            SAMPLING_APIS.includes(api ?? 'openai-completions')
              ? 'Merged into every request, e.g. temperature or top_p.'
              : 'Ignored by this API type.'
          }
        >
          <KeyValueEditor
            value={Object.fromEntries(
              Object.entries(params).map(([key, value]) => [key, samplingText(value)])
            )}
            keyPlaceholder="temperature"
            valuePlaceholder="0.7"
            addLabel="Add parameter"
            onChange={(next) =>
              onChange(
                withObject(
                  target,
                  'samplingParams',
                  Object.fromEntries(
                    Object.entries(next).map(([key, text]) => [key, samplingValue(text)])
                  )
                )
              )
            }
          />
        </Block>
      )}
    </div>
  )
}
