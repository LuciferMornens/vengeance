import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Boxes, ChevronRight, CircleAlert, FileJson, FolderOpen, Plus, Trash2 } from 'lucide-react'
import {
  MODEL_API_TYPES,
  type JsonObject,
  type ModelsJsonState,
  type ValidationIssue
} from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import { isImeComposing } from '../../../lib/keybindings'
import { invoke } from '../ipc'
import {
  Badge,
  Button,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
  toast
} from '../../../ui'
import { Collapse } from '../../../ui/Collapse'
import { TextField } from '../controls'
import { Group, KeyHint, Note, Row } from '../layout'
import { useSettings } from '../store'
import {
  formatJson,
  IssueList,
  JsonEditor,
  parseJsonText,
  type JsonParseResult
} from './json-editor'
import { AdvancedModelFields } from './model-advanced'
import {
  ModelRow,
  ModelOverrides,
  MODEL_GRID,
  hasAdvanced,
  obj,
  withField,
  type ModelDraft
} from './custom-model-rows'

/** models.json: custom providers (Ollama, LM Studio, proxies) and overrides of built-in ones. */

type ProviderDraft = JsonObject
/** Radix Select items cannot use an empty value, so "no `api` key" gets a sentinel. */
const API_DEFAULT = 'default'
const API_OPTIONS = [
  { value: API_DEFAULT, label: 'Inherit / default' },
  ...MODEL_API_TYPES.map((api) => ({ value: api, label: api }))
]

/** A models.json entry without `models` only overrides a built-in provider (base URL, headers, key, model metadata). */
function ProviderCard({
  id,
  provider,
  builtin,
  issues,
  onChange,
  onRemove
}: {
  id: string
  provider: ProviderDraft
  builtin: boolean
  issues: ValidationIssue[]
  onChange: (next: ProviderDraft) => void
  onRemove: () => void
}) {
  const engine = useSettings((state) => state.engine)
  const catalog = useSettings((s) => s.catalog)
  const [advanced, setAdvanced] = useState(false)
  const models = Array.isArray(provider.models) ? provider.models.map(obj) : []
  // A built-in provider's protocol comes from its catalog models when the entry doesn't set one.
  const api =
    typeof provider.api === 'string'
      ? provider.api
      : catalog?.models.find((m) => m.provider === id)?.api
  const setModels = (next: ModelDraft[]) =>
    onChange(withField(provider, 'models', next.length ? next : undefined))
  return (
    <Group
      title={
        <span className="flex items-center gap-2 font-mono text-sm tracking-normal text-fg normal-case">
          {id}
          <Badge>{builtin ? 'Overrides built-in' : 'Custom'}</Badge>
          <span className="font-sans text-xs font-normal text-fg-3">
            {models.length} {models.length === 1 ? 'model' : 'models'}
          </span>
        </span>
      }
      actions={
        <IconButton label={`Remove ${id}`} size="sm" onClick={onRemove}>
          <Trash2 />
        </IconButton>
      }
    >
      {issues.length > 0 && (
        <div className="border-b border-hairline-soft bg-danger-soft/40">
          {issues.map((issue, i) => (
            <Note
              key={i}
              tone={issue.severity === 'error' ? 'danger' : 'warning'}
              icon={<CircleAlert />}
            >
              {issue.message}
            </Note>
          ))}
        </div>
      )}
      <Row
        label="Base URL"
        description={
          builtin
            ? 'Route the built-in provider through a proxy or gateway.'
            : 'OpenAI-compatible endpoint, e.g. a local Ollama or LM Studio server.'
        }
        wide
      >
        <TextField
          mono
          value={typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined}
          placeholder={builtin ? 'Built-in endpoint' : 'http://localhost:11434/v1'}
          onCommit={(v) => onChange(withField(provider, 'baseUrl', v))}
        />
      </Row>
      <Row label="API type" description="Wire protocol the endpoint speaks." wide>
        <Select
          className="w-full"
          value={typeof provider.api === 'string' ? provider.api : API_DEFAULT}
          onValueChange={(v) =>
            onChange(withField(provider, 'api', v === API_DEFAULT ? undefined : v))
          }
          options={API_OPTIONS.filter(
            (option) => engine === 'pi' || option.value !== 'pi-messages'
          )}
        />
      </Row>
      <Row
        label="API key"
        description={
          <>
            An environment variable name, <KeyHint>!command</KeyHint>, or a literal key. Stored keys
            are masked.
          </>
        }
        wide
      >
        <TextField
          mono
          value={typeof provider.apiKey === 'string' ? provider.apiKey : undefined}
          placeholder={builtin ? 'Signed-in account or key' : 'OLLAMA_API_KEY'}
          onCommit={(v) => onChange(withField(provider, 'apiKey', v))}
        />
      </Row>
      <button
        type="button"
        aria-expanded={advanced}
        onClick={() => setAdvanced((v) => !v)}
        className="flex w-full items-center gap-2 border-t border-hairline-soft px-4 py-2.5 text-left text-sm text-fg-2 transition-colors hover:bg-hover hover:text-fg"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-fg-3 transition-transform duration-[var(--dur-fast)]',
            advanced && 'rotate-90'
          )}
        />
        Headers and compatibility
        {hasAdvanced(provider, engine) && !advanced && (
          <span className="text-xs text-fg-3">· set</span>
        )}
      </button>
      <Collapse open={advanced}>
        <div className="px-4 pt-1 pb-4">
          <AdvancedModelFields target={provider} api={api} onChange={onChange} />
        </div>
      </Collapse>
      <div className="border-t border-hairline-soft bg-surface-1/40">
        {models.length > 0 && (
          <div className={cn(MODEL_GRID, 'pt-2.5 pb-1 text-xs font-medium text-fg-3')}>
            <span>Model id</span>
            <span>Name</span>
            <span>Context</span>
            <span>Max output</span>
            <span className="w-8 text-center">Think</span>
            <span className="w-8 text-center">Image</span>
            <span className="w-7" />
            <span className="w-7" />
          </div>
        )}
        {models.map((model, index) => (
          <ModelRow
            key={index}
            model={model}
            api={api}
            onChange={(next) => setModels(models.map((m, i) => (i === index ? next : m)))}
            onRemove={() => setModels(models.filter((_, i) => i !== index))}
          />
        ))}
        <div className="px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            leading={<Plus />}
            onClick={() => setModels([...models, { id: '' }])}
          >
            Add model
          </Button>
        </div>
      </div>
      {/* Overrides target models the provider already has (built-in or from extensions), not ones defined above. */}
      {(builtin || provider.modelOverrides !== undefined) && (
        <ModelOverrides
          providerId={id}
          overrides={obj(provider.modelOverrides)}
          onChange={(next) => onChange(withField(provider, 'modelOverrides', next))}
        />
      )}
    </Group>
  )
}

export function CustomModelsSection() {
  const [file, setFile] = useState<ModelsJsonState | null>(null)
  const [draft, setDraft] = useState<JsonObject>({})
  const [mode, setMode] = useState<'visual' | 'json'>('visual')
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [saving, setSaving] = useState(false)
  const [newId, setNewId] = useState('')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<JsonParseResult['error']>()
  const catalog = useSettings((s) => s.catalog)
  const loadCatalog = useSettings((s) => s.loadCatalog)

  const reload = async () => {
    const state = await invoke('settings:models-json')
    setFile(state)
    setDraft(state.data)
  }
  useEffect(() => {
    void reload()
    void loadCatalog()
  }, [loadCatalog])

  const dirty = !!file && JSON.stringify(draft) !== JSON.stringify(file.data)
  useEffect(() => {
    if (!dirty) {
      setIssues([])
      return
    }
    const timer = setTimeout(
      () => void invoke('settings:models-json-validate', draft).then(setIssues),
      250
    )
    return () => clearTimeout(timer)
  }, [draft, dirty])

  const providers = obj(draft.providers)
  const setProviders = (next: JsonObject) =>
    setDraft(withField(draft, 'providers', Object.keys(next).length ? next : undefined))

  const save = async () => {
    setSaving(true)
    try {
      const state = await invoke('settings:models-json-write', draft)
      setFile(state)
      setDraft(state.data)
      setJsonText(state.text)
      toast({
        level: 'success',
        title: 'Custom models saved',
        description: 'New sessions see them right away.'
      })
    } catch (error) {
      toast({ level: 'error', title: 'Not saved', description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const addProvider = () => {
    const id = newId.trim()
    if (!id || id in providers) return
    // A built-in provider id starts as an override entry (no models list); anything else as a local server.
    const builtinProvider = catalog?.providers.some((p) => p.id === id)
    setProviders({
      ...providers,
      [id]: builtinProvider
        ? {}
        : {
            baseUrl: 'http://localhost:11434/v1',
            api: 'openai-completions',
            apiKey: 'ollama',
            models: []
          }
    })
    setNewId('')
  }

  if (!file) {
    return (
      <Group>
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      </Group>
    )
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length
  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <SegmentedControl
          value={mode}
          onValueChange={(next) => {
            if (next === 'json') {
              setJsonText(formatJson(draft))
              setJsonError(undefined)
            }
            setMode(next)
          }}
          segments={[
            { value: 'visual', label: 'Providers' },
            { value: 'json', label: 'JSON' }
          ]}
        />
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{file.path}</code>
        <Button
          size="sm"
          variant="ghost"
          leading={<FolderOpen />}
          onClick={() => void invoke('sys:reveal', file.path)}
        >
          Reveal
        </Button>
      </div>

      {file.error && (
        <Group>
          <Note tone="danger" icon={<CircleAlert />}>
            models.json could not be read: {file.error}. Fix it in a text editor, then reopen this
            page.
          </Note>
        </Group>
      )}
      {catalog?.error && !file.error && (
        <Group>
          <Note tone="warning" icon={<CircleAlert />}>
            The engine reported: {catalog.error}
          </Note>
        </Group>
      )}

      {mode === 'json' ? (
        <>
          <JsonEditor
            aria-label="models.json"
            text={jsonText}
            errorLine={jsonError?.line}
            height={460}
            onChange={(text) => {
              setJsonText(text)
              const parsed = parseJsonText(text)
              setJsonError(parsed.error)
              if (parsed.data) setDraft(parsed.data)
            }}
          />
          <IssueList issues={issues} parseError={jsonError} />
        </>
      ) : (
        <>
          {Object.keys(providers).length === 0 && (
            <Group>
              <Note icon={<Boxes />}>
                No custom providers. Add a local server like Ollama or LM Studio, or override a
                built-in provider’s base URL.
              </Note>
            </Group>
          )}
          {Object.entries(providers).map(([id, raw]) => (
            <ProviderCard
              key={id}
              id={id}
              provider={obj(raw)}
              builtin={!Array.isArray(obj(raw).models)}
              issues={issues.filter(
                (i) => i.key === `providers.${id}` || i.key.startsWith(`providers.${id}.`)
              )}
              onChange={(next) => setProviders({ ...providers, [id]: next })}
              onRemove={() => {
                const { [id]: _removed, ...rest } = providers
                setProviders(rest)
              }}
            />
          ))}
          <div className="flex items-center gap-2">
            <datalist id="models-json-providers">
              {(catalog?.providers ?? [])
                .filter((p) => !(p.id in providers))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </datalist>
            <Input
              list="models-json-providers"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isImeComposing(e) && addProvider()}
              placeholder="Provider id, e.g. ollama"
              spellCheck={false}
              className="h-8 w-64 bg-surface-1 font-mono text-sm"
            />
            <Button
              size="md"
              variant="secondary"
              leading={<Plus />}
              disabled={!newId.trim() || newId.trim() in providers}
              onClick={addProvider}
            >
              Add provider
            </Button>
          </div>
        </>
      )}

      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="sticky bottom-4 z-10 mt-6 flex items-center gap-3 rounded-card bg-surface-3 px-4 py-2.5 shadow-[var(--highlight),0_0_0_1px_var(--hairline-strong),var(--shadow-lg)]"
          >
            <FileJson className="size-4 text-fg-3" />
            <span className={cn('flex-1 text-sm', errorCount ? 'text-danger' : 'text-fg-2')}>
              {errorCount
                ? `${errorCount} ${errorCount === 1 ? 'problem' : 'problems'} to fix before saving`
                : 'Unsaved changes to models.json'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(file.data)
                setJsonText(formatJson(file.data))
                setJsonError(undefined)
              }}
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={saving}
              disabled={errorCount > 0 || !!jsonError}
              onClick={() => void save()}
            >
              Save
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
