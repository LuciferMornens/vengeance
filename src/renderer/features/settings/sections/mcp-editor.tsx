import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, FolderGit2, Globe, Plus, Terminal, X } from 'lucide-react'
import type { McpExposure, McpOverview, McpServerDraft } from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import {
  Button,
  Dialog,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Textarea,
  toast
} from '../../../ui'
import { FOCUS_RING, KeyValueEditor, ListEditor, NumberField } from '../controls'
import { invoke } from '../ipc'
import { KeyHint } from '../layout'
import { activeCwd, useSettings } from '../store'

export const EXPOSURE_OPTIONS: { value: McpExposure; label: string; description: string }[] = [
  {
    value: 'codemode',
    label: 'Code mode',
    description: 'Called from scripts; keeps the tool list small'
  },
  { value: 'deferred', label: 'Deferred', description: 'Searchable, loaded on demand' },
  { value: 'direct', label: 'Direct', description: 'Every tool always visible to the model' },
  { value: 'hidden', label: 'Hidden', description: 'Connected but not exposed' }
]

// ─── Server editor ──────────────────────────────────────────────────────────

const EMPTY_DRAFT: McpServerDraft = {
  name: '',
  transport: 'stdio',
  args: [],
  env: {},
  headers: {},
  enabled: true,
  exposure: 'codemode',
  toolExposure: {}
}

function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="text-sm font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-fg-3">{hint}</span>}
    </label>
  )
}

function EditorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3.5 border-t border-hairline-soft pt-4 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-medium text-fg-3">{title}</h4>
      {children}
    </section>
  )
}

const inputClass = cn('bg-surface-1 font-mono text-sm', FOCUS_RING)

/** Exact tool names or `*` patterns mapped to an exposure (exact names win; first matching pattern wins). */
function ToolExposureTable({
  value,
  onChange
}: {
  value: Record<string, McpExposure>
  onChange: (next: Record<string, McpExposure>) => void
}) {
  const [rows, setRows] = useState<Array<[string, McpExposure]>>(() => Object.entries(value))
  const emit = (next: Array<[string, McpExposure]>) => {
    setRows(next)
    onChange(
      Object.fromEntries(
        next.filter(([tool]) => tool.trim()).map(([tool, exposure]) => [tool.trim(), exposure])
      )
    )
  }
  return (
    <div className="overflow-hidden rounded-card bg-surface-1 shadow-[inset_0_0_0_1px_var(--hairline)]">
      {rows.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_150px_28px] gap-2 border-b border-hairline-soft px-3 py-1.5 text-xs font-medium text-fg-3">
          <span>Tool or pattern</span>
          <span>Exposure</span>
          <span />
        </div>
      )}
      {rows.map(([tool, exposure], index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_150px_28px] items-center gap-2 border-b border-hairline-soft px-3 py-1.5 last:border-b-0"
        >
          <input
            aria-label="Tool name or pattern"
            value={tool}
            spellCheck={false}
            placeholder="search_code or get_*"
            onChange={(e) =>
              emit(rows.map((row, i) => (i === index ? [e.target.value, row[1]] : row)))
            }
            className={cn(
              'h-7 min-w-0 rounded-md bg-transparent px-1.5 font-mono text-xs text-fg placeholder:text-fg-3',
              FOCUS_RING
            )}
          />
          <Select
            size="sm"
            value={exposure}
            onValueChange={(next) =>
              emit(rows.map((row, i) => (i === index ? [row[0], next] : row)))
            }
            options={EXPOSURE_OPTIONS}
          />
          <IconButton
            label="Remove rule"
            size="sm"
            onClick={() => emit(rows.filter((_, i) => i !== index))}
          >
            <X />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows([...rows, ['', 'direct']])}
        className="flex h-8 w-full items-center gap-1.5 px-3 text-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5"
      >
        <Plus />
        Add rule
      </button>
    </div>
  )
}

export interface EditorTarget {
  /** Existing entry, or null to add a new one. */
  name: string | null
  scope: 'global' | 'project'
}

export function ServerEditor({
  target,
  onClose,
  onSaved
}: {
  target: EditorTarget | null
  onClose: () => void
  onSaved: (overview: McpOverview) => void
}) {
  const hasProject = useSettings((s) => !!s.snapshot?.project)
  const [draft, setDraft] = useState<McpServerDraft | null>(null)
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [saving, setSaving] = useState(false)
  const [showOAuth, setShowOAuth] = useState(false)

  useEffect(() => {
    if (!target) return
    setScope(target.scope)
    setShowOAuth(false)
    if (target.name === null) {
      setDraft({ ...EMPTY_DRAFT })
      return
    }
    setDraft(null)
    invoke('settings:mcp-server', activeCwd(), target.name, target.scope).then(
      (loaded) => {
        setDraft(loaded)
        setShowOAuth(!!loaded.oauth && Object.values(loaded.oauth).some((v) => v !== undefined))
      },
      (error: Error) => {
        toast({ level: 'error', title: 'Could not open server', description: error.message })
        onClose()
      }
    )
  }, [target, onClose])

  const patch = (p: Partial<McpServerDraft>) => setDraft((d) => (d ? { ...d, ...p } : d))
  const patchOAuth = (p: Partial<NonNullable<McpServerDraft['oauth']>>) =>
    setDraft((d) => (d ? { ...d, oauth: { ...d.oauth, ...p } } : d))
  const valid =
    !!draft &&
    /^[A-Za-z0-9_-]+$/.test(draft.name) &&
    (draft.transport === 'stdio' ? !!draft.command?.trim() : /^https?:\/\//.test(draft.url ?? ''))
  const adding = target?.name === null

  const save = async () => {
    if (!draft || !target) return
    setSaving(true)
    try {
      onSaved(
        await invoke('settings:mcp-save', {
          cwd: activeCwd(),
          scope,
          previousName: target.name ?? undefined,
          server: draft
        })
      )
      toast({
        level: 'success',
        title: adding ? `Added ${draft.name}` : `Saved ${draft.name}`,
        description: 'New sessions connect with this configuration.'
      })
      onClose()
    } catch (error) {
      toast({ level: 'error', title: 'Server not saved', description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      width={640}
      title={adding ? 'Add MCP server' : `Edit ${target?.name ?? ''}`}
      description={`Saved to the ${scope === 'project' ? 'project' : 'global'} mcp.json. Unknown keys and secrets stay as they are.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={saving} onClick={() => void save()}>
            {adding ? 'Add server' : 'Save'}
          </Button>
        </>
      }
    >
      {!draft ? (
        <div className="space-y-3 py-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
        </div>
      ) : (
        <div className="space-y-5 pb-2">
          <EditorSection title="Connection">
            <div className="flex items-end gap-3">
              <Field label="Name" className="flex-1">
                <Input
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="github"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              <SegmentedControl
                value={draft.transport}
                onValueChange={(transport) => patch({ transport })}
                segments={[
                  { value: 'stdio', label: 'Command', icon: <Terminal /> },
                  { value: 'http', label: 'HTTP', icon: <Globe /> }
                ]}
              />
              {adding && hasProject && (
                <SegmentedControl
                  value={scope}
                  onValueChange={setScope}
                  segments={[
                    { value: 'global', label: 'Global' },
                    { value: 'project', label: 'Project', icon: <FolderGit2 /> }
                  ]}
                />
              )}
            </div>
            {draft.transport === 'stdio' ? (
              <>
                <Field
                  label="Command"
                  hint="One executable, not a shell line. A leading ~/ names your home folder."
                >
                  <Input
                    value={draft.command ?? ''}
                    onChange={(e) => patch({ command: e.target.value })}
                    placeholder="npx"
                    spellCheck={false}
                    className={inputClass}
                  />
                </Field>
                <Field label="Arguments" hint="Press Enter after each argument.">
                  <ListEditor
                    mono
                    unique={false}
                    value={draft.args ?? []}
                    onChange={(args) => patch({ args })}
                    placeholder="-y, @modelcontextprotocol/server-github"
                  />
                </Field>
                <Field
                  label="Working directory"
                  hint="Relative paths resolve against the session folder."
                >
                  <Input
                    value={draft.cwd ?? ''}
                    onChange={(e) => patch({ cwd: e.target.value || undefined })}
                    placeholder="Session folder"
                    spellCheck={false}
                    className={inputClass}
                  />
                </Field>
                <Field
                  label="Environment"
                  hint={
                    <>
                      Use <KeyHint>{'${VAR}'}</KeyHint> or <KeyHint>!command</KeyHint> to keep
                      secrets out of the file.
                    </>
                  }
                >
                  <KeyValueEditor
                    value={draft.env ?? {}}
                    onChange={(env) => patch({ env })}
                    keyPlaceholder="API_KEY"
                    addLabel="Add variable"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL" hint="Streamable HTTP endpoint. Legacy SSE is not supported.">
                  <Input
                    value={draft.url ?? ''}
                    onChange={(e) => patch({ url: e.target.value })}
                    placeholder="https://mcp.example.com/mcp"
                    spellCheck={false}
                    className={inputClass}
                  />
                </Field>
                <Field
                  label="Headers"
                  hint={
                    <>
                      Without an Authorization header the server signs in with OAuth. Values may use{' '}
                      <KeyHint>{'${VAR}'}</KeyHint>.
                    </>
                  }
                >
                  <KeyValueEditor
                    value={draft.headers ?? {}}
                    onChange={(headers) => patch({ headers })}
                    keyPlaceholder="Authorization"
                    valuePlaceholder="Bearer ${TOKEN}"
                    addLabel="Add header"
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => setShowOAuth((v) => !v)}
                  className="flex items-center gap-1.5 text-sm text-fg-3 transition-colors hover:text-fg [&_svg]:size-3.5"
                >
                  <ChevronRight
                    className={cn(
                      'transition-transform duration-[var(--dur-fast)]',
                      showOAuth && 'rotate-90'
                    )}
                  />
                  OAuth client
                  <span className="text-fg-3">· for servers without dynamic registration</span>
                </button>
                {showOAuth && (
                  <div className="grid grid-cols-2 gap-3 rounded-card bg-surface-1 p-3.5 shadow-[inset_0_0_0_1px_var(--hairline)]">
                    <Field label="Client ID">
                      <Input
                        value={draft.oauth?.clientId ?? ''}
                        onChange={(e) => patchOAuth({ clientId: e.target.value || undefined })}
                        spellCheck={false}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Client secret">
                      <Input
                        value={draft.oauth?.clientSecret ?? ''}
                        onChange={(e) => patchOAuth({ clientSecret: e.target.value || undefined })}
                        placeholder="${CLIENT_SECRET}"
                        spellCheck={false}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Callback port">
                      <NumberField
                        aria-label="Callback port"
                        value={draft.oauth?.callbackPort}
                        integer
                        min={1}
                        max={65535}
                        showHint={false}
                        className="[&>div]:w-full [&_input]:w-full"
                        placeholder="Any free port"
                        onCommit={(callbackPort) => patchOAuth({ callbackPort })}
                      />
                    </Field>
                    <Field label="Callback URL">
                      <Input
                        value={draft.oauth?.callbackUrl ?? ''}
                        onChange={(e) => patchOAuth({ callbackUrl: e.target.value || undefined })}
                        placeholder="http://127.0.0.1/callback"
                        spellCheck={false}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Scope">
                      <Input
                        value={draft.oauth?.scope ?? ''}
                        onChange={(e) => patchOAuth({ scope: e.target.value || undefined })}
                        placeholder="Advertised scopes"
                        spellCheck={false}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Client name">
                      <Input
                        value={draft.oauth?.clientName ?? ''}
                        onChange={(e) => patchOAuth({ clientName: e.target.value || undefined })}
                        placeholder="Engine default"
                        className={cn('bg-surface-1 text-sm', FOCUS_RING)}
                      />
                    </Field>
                    <Field label="Registration">
                      <Select
                        className="w-full"
                        value={draft.oauth?.clientRegistration ?? 'dynamic'}
                        onValueChange={(v) =>
                          patchOAuth({ clientRegistration: v === 'cimd' ? 'cimd' : undefined })
                        }
                        options={[
                          { value: 'dynamic', label: 'Dynamic registration' },
                          { value: 'cimd', label: 'Client ID metadata document' }
                        ]}
                      />
                    </Field>
                    <Field label="Auth server metadata">
                      <Input
                        value={draft.oauth?.authServerMetadataUrl ?? ''}
                        onChange={(e) =>
                          patchOAuth({ authServerMetadataUrl: e.target.value || undefined })
                        }
                        placeholder="Discovered"
                        spellCheck={false}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                )}
              </>
            )}
          </EditorSection>

          <EditorSection title="Tools">
            <div className="flex gap-3">
              <Field label="Expose tools as" className="flex-1">
                <Select
                  className="w-full"
                  value={draft.exposure}
                  onValueChange={(exposure) => patch({ exposure })}
                  options={EXPOSURE_OPTIONS}
                />
              </Field>
              <Field label="Timeout">
                <NumberField
                  aria-label="Timeout in seconds"
                  value={draft.timeout}
                  integer
                  min={1}
                  showHint={false}
                  placeholder={60}
                  onCommit={(timeout) => patch({ timeout })}
                />
              </Field>
            </div>
            <Field
              label="Per-tool exposure"
              hint="Exact names win over patterns; among patterns the first match wins."
            >
              <ToolExposureTable
                value={draft.toolExposure ?? {}}
                onChange={(toolExposure) => patch({ toolExposure })}
              />
            </Field>
            <Field
              label="Description"
              hint="Lists the server in the system prompt and ranks its tools in tool search."
            >
              <Textarea
                rows={2}
                value={draft.description ?? ''}
                onChange={(e) => patch({ description: e.target.value || undefined })}
                placeholder="What the model should use it for"
                className={cn('bg-surface-1', FOCUS_RING)}
              />
            </Field>
            <div className="flex items-center justify-between rounded-card bg-surface-1 px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--hairline)]">
              <div>
                <div className="text-ui font-medium text-fg">Enabled</div>
                <div className="text-sm text-fg-3">
                  Disabled servers stay in the file without connecting.
                </div>
              </div>
              <Switch
                aria-label="Enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
              />
            </div>
          </EditorSection>
        </div>
      )}
    </Dialog>
  )
}
