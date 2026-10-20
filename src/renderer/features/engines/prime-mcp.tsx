import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, Pencil, Plus, RefreshCw, RotateCw, Server, Trash2 } from 'lucide-react'
import type { JsonObject, JsonValue, McpServerStatus } from '@shared/api/settings'
import { cn } from '../../lib/cn'
import { invoke } from '../../lib/ipc'
import { Badge, Button, Dialog, IconButton, Input, Select, Switch } from '../../ui'
import {
  MCP_DOT,
  mcpStateTone,
  plural,
  workspaceStateText,
  type WorkspaceMcpServer
} from '../mcp/status'
import { canReconnectInSessions, reconnectInSessions, useWorkspaceMcp } from '../mcp/workspace'
import { KeyValueEditor, ListEditor, NumberField } from '../settings/controls'
import { LoginDialog, useLoginFlow } from '../settings/auth-flow'
import { afterEngineConfigChange, agentsForEngine } from '../settings/engines'
import { settingsInvokeForFolder } from '../settings/ipc'
import { Group, Note, Row } from '../settings/layout'
import { ProcessLog, useRuns } from '../settings/process-log'
import { activeCwd, useResolved, useSettings } from '../settings/store'

function objectValue(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringRecord(value: JsonValue | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectValue(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
}

function environmentReferences(value: JsonValue | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectValue(value)).map(([name, entry]) => [
      name,
      stringValue(objectValue(entry).env)
    ])
  )
}

function mergeServerConfig(global: JsonObject, project: JsonObject): JsonObject {
  const merged = { ...global }
  for (const [key, value] of Object.entries(project)) {
    if (value === null || value === undefined) continue
    const nested = value && typeof value === 'object' && !Array.isArray(value)
    merged[key] = nested ? mergeServerConfig(objectValue(merged[key]), value) : value
  }
  return merged
}

function projectServerOverlay(
  initial: JsonObject,
  edited: JsonObject,
  local: JsonObject,
  inherited: JsonObject,
  path: string[] = []
): JsonObject {
  const overlay = { ...local }
  for (const key of new Set([...Object.keys(initial), ...Object.keys(edited)])) {
    const before = initial[key]
    const after = edited[key]
    if (after === undefined) {
      if (local[key] !== undefined) delete overlay[key]
      else if (inherited[key] !== undefined && inherited[key] !== null) {
        throw new Error(`Edit global settings to remove inherited ${[...path, key].join('.')}.`)
      }
    } else if (after !== null && typeof after === 'object' && !Array.isArray(after)) {
      const nested = projectServerOverlay(
        objectValue(before),
        after,
        objectValue(local[key]),
        objectValue(inherited[key]),
        [...path, key]
      )
      if (Object.keys(nested).length > 0 || local[key] !== undefined) overlay[key] = nested
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      overlay[key] = after
    }
  }
  return overlay
}

interface PrimeMcpEditorProps {
  name: string | null
  initial: JsonObject
  project: boolean
  names: string[]
  onClose: () => void
  onSave: (name: string, config: JsonObject) => Promise<void>
}

function PrimeMcpEditor({ name, initial, project, names, onClose, onSave }: PrimeMcpEditorProps) {
  const [draftName, setDraftName] = useState(name ?? '')
  const [draft, setDraft] = useState<JsonObject>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const transport = draft.type === 'http' ? 'http' : 'stdio'
  const patch = (key: string, value: JsonValue | undefined) =>
    setDraft((current) => {
      const next = { ...current }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
  const save = async () => {
    const serverName = draftName.trim()
    if (!serverName) {
      setError('Enter a server name.')
      return
    }
    if (!name && names.includes(serverName)) {
      setError('A server with this name already exists. Choose another name.')
      return
    }
    if (transport === 'stdio' && !stringValue(draft.command).trim()) {
      setError('Enter the executable that starts this server.')
      return
    }
    if (transport === 'http') {
      try {
        const parsed = new URL(stringValue(draft.url))
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
      } catch {
        setError('Enter a valid HTTP or HTTPS server URL.')
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(serverName, draft)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
      title={name ? `Edit ${name}` : 'Add MCP server'}
      description={
        project
          ? 'Project saves changed values. Remove inherited values in global settings.'
          : 'Configure the connection, credentials and tool access for Engine 2.'
      }
      icon={<Server />}
      size="editor"
      persistent
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save server
          </Button>
        </>
      }
    >
      <div className="space-y-5 pb-3">
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <label className="block space-y-2 text-sm text-fg-2">
          <span>Server name</span>
          <Input
            value={draftName}
            disabled={!!name || saving}
            onChange={(event) => setDraftName(event.target.value)}
          />
        </label>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium text-fg-2">Connection</span>
          <Select
            value={transport}
            disabled={saving}
            options={[
              { value: 'stdio', label: 'Local executable' },
              { value: 'http', label: 'HTTP server' }
            ]}
            onValueChange={(next) => patch('type', next)}
          />
        </div>
        {transport === 'http' ? (
          <>
            <label className="block space-y-2 text-sm text-fg-2">
              <span>Server URL</span>
              <Input
                value={stringValue(draft.url)}
                placeholder="https://example.com/mcp"
                onChange={(event) => patch('url', event.target.value)}
              />
            </label>
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-fg-2">HTTP headers</h4>
              <KeyValueEditor
                value={stringRecord(draft.headers)}
                onChange={(value) => patch('headers', value)}
                keyPlaceholder="Header name"
                addLabel="Add header"
              />
            </div>
            <label className="block space-y-2 text-sm text-fg-2">
              <span>Bearer token environment variable</span>
              <Input
                value={stringValue(draft.bearerTokenEnvVar)}
                placeholder="MCP_ACCESS_TOKEN"
                onChange={(event) => patch('bearerTokenEnvVar', event.target.value || undefined)}
              />
            </label>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-fg-2">Use OAuth sign-in</span>
              <Switch
                aria-label="Use OAuth sign-in"
                checked={draft.oauth === true}
                onCheckedChange={(checked) => patch('oauth', checked)}
              />
            </div>
          </>
        ) : (
          <>
            <label className="block space-y-2 text-sm text-fg-2">
              <span>Executable</span>
              <Input
                value={stringValue(draft.command)}
                placeholder="npx"
                onChange={(event) => patch('command', event.target.value)}
              />
            </label>
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-fg-2">Arguments</h4>
              <ListEditor
                value={stringList(draft.args)}
                unique={false}
                onChange={(value) => patch('args', value)}
                placeholder="Add an argument…"
              />
            </div>
            <label className="block space-y-2 text-sm text-fg-2">
              <span>Working directory</span>
              <Input
                value={stringValue(draft.cwd)}
                onChange={(event) => patch('cwd', event.target.value || undefined)}
              />
            </label>
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-fg-2">Environment references</h4>
              <p className="text-xs leading-relaxed text-fg-3">
                Map each server variable to a variable available in the engine environment.
              </p>
              <KeyValueEditor
                value={environmentReferences(draft.env)}
                keyPlaceholder="Server variable"
                valuePlaceholder="Engine variable"
                addLabel="Add environment reference"
                onChange={(values) =>
                  patch(
                    'env',
                    Object.fromEntries(
                      Object.entries(values).map(([key, value]) => [key, { env: value }])
                    )
                  )
                }
              />
            </div>
          </>
        )}
        <div className="space-y-4 border-t border-hairline-soft pt-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-fg-2">Enabled</span>
            <Switch
              aria-label="Enable server"
              checked={draft.enabled !== false}
              onCheckedChange={(checked) => patch('enabled', checked)}
            />
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-fg-2">Allowed tools</h4>
            <ListEditor
              value={stringList(draft.enabledTools)}
              onChange={(value) => patch('enabledTools', value.length ? value : undefined)}
              placeholder="All tools unless listed here"
            />
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-fg-2">Blocked tools</h4>
            <ListEditor
              value={stringList(draft.disabledTools)}
              onChange={(value) => patch('disabledTools', value.length ? value : undefined)}
              placeholder="Add a tool name…"
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-fg-2">Startup timeout</span>
            <NumberField
              aria-label="Startup timeout"
              value={
                typeof draft.startupTimeoutMs === 'number' ? draft.startupTimeoutMs : undefined
              }
              min={0}
              integer
              unit="ms"
              onCommit={(value) => patch('startupTimeoutMs', value)}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-fg-2">Tool call timeout</span>
            <NumberField
              aria-label="Tool call timeout"
              value={typeof draft.callTimeoutMs === 'number' ? draft.callTimeoutMs : undefined}
              min={0}
              integer
              unit="ms"
              onCommit={(value) => patch('callTimeoutMs', value)}
            />
          </div>
        </div>
      </div>
    </Dialog>
  )
}

type McpAuthenticationAction = 'login' | 'logout' | 'token'

/** Engine 2's connection states (`connectionStatus`) in words. */
const CONFIGURED_STATE: Record<string, string> = {
  connected: 'Connected',
  pending: 'Signed in, not verified',
  not_connected: 'Not connected',
  disconnected: 'Not connected',
  setup_required: 'Needs setup',
  disabled: 'Off',
  error: 'Needs attention'
}

/** States without a stored credential, so there is nothing to sign out of. */
const NOTHING_TO_SIGN_OUT = new Set(['not_connected', 'setup_required', 'disabled'])

/** Catalog services this account set up; the rest of the catalog stays folded away. */
const SET_UP_STATES = new Set(['connected', 'pending', 'error', 'disabled'])

function configuredState(state: string | undefined): string {
  if (!state) return 'Configured'
  return CONFIGURED_STATE[state] ?? state.replaceAll('_', ' ')
}

/** The state in the folder's open sessions, or the configured state when none runs the server. */
function ServerState({ live, configured }: { live: WorkspaceMcpServer | undefined; configured: string }) {
  if (!live) return <Badge>{configured}</Badge>
  return (
    <span
      data-mcp-row-state={live.server.state}
      data-mcp-row-live
      className={cn(
        'flex max-w-[52ch] items-center gap-1.5 text-xs break-words',
        mcpStateTone(live.server.state)
      )}
    >
      <span className={cn('size-2 shrink-0 rounded-full', MCP_DOT[live.server.state])} aria-hidden />
      <span className="line-clamp-2">{workspaceStateText(live)}</span>
    </span>
  )
}

/** Engine 2 reconnects at once, also a server whose status read had it still opening. */
function ReconnectButton({ name, live }: { name: string; live: WorkspaceMcpServer | undefined }) {
  if (!canReconnectInSessions(live)) return null
  return (
    <IconButton
      label={`Reconnect ${name} in open sessions in this folder`}
      onClick={() => void reconnectInSessions(name, live)}
    >
      <RotateCw />
    </IconButton>
  )
}

/** A connection's sign-in and setup actions and tool count; empty when it offers none. */
function connectionActions({
  name,
  status,
  oauth,
  onAuthenticate,
  onOpenDocs
}: {
  name: string
  status?: McpServerStatus
  oauth: boolean
  onAuthenticate: (name: string, action: McpAuthenticationAction) => Promise<void>
  onOpenDocs: (url: string) => Promise<void>
}): ReactNode[] {
  const actions: ReactNode[] = []
  if (oauth && status?.connectable !== false && status?.state !== 'connected') {
    actions.push(
      <Button key="login" size="xs" onClick={() => void onAuthenticate(name, 'login')}>
        Sign in
      </Button>
    )
  }
  if (status?.pasteToken === true) {
    actions.push(
      <Button key="token" size="xs" onClick={() => void onAuthenticate(name, 'token')}>
        Paste token
      </Button>
    )
  }
  if ((oauth || status?.pasteToken === true) && !NOTHING_TO_SIGN_OUT.has(status?.state ?? '')) {
    actions.push(
      <Button
        key="logout"
        size="xs"
        variant="ghost"
        onClick={() => void onAuthenticate(name, 'logout')}
      >
        Sign out
      </Button>
    )
  }
  const docsUrl = status?.docsUrl
  if (docsUrl) {
    actions.push(
      <Button key="docs" size="xs" variant="ghost" onClick={() => void onOpenDocs(docsUrl)}>
        Setup guide
      </Button>
    )
  }
  if (typeof status?.toolCount === 'number') {
    actions.push(
      <span key="tools" className="text-xs text-fg-3">
        {plural(status.toolCount, 'tool')} available
      </span>
    )
  }
  return actions
}

export function PrimeMcpSection() {
  const resolved = useResolved('mcpServers')
  const replaceSnapshot = useSettings((state) => state.replaceSnapshot)
  const scope = useSettings((state) => state.scope)
  const globalServers = objectValue(resolved.globalValue)
  const projectServers = objectValue(resolved.projectValue)
  const servers =
    scope === 'project' ? mergeServerConfig(globalServers, projectServers) : globalServers
  const [editing, setEditing] = useState<{ name: string | null; config: JsonObject } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const run = useRuns((state) => (runId ? state.runs[runId] : undefined))
  const workspace = useSettings((state) => state.snapshot?.project?.cwd) ?? activeCwd()
  const live = useWorkspaceMcp('prime', workspace)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStatuses(
        await settingsInvokeForFolder('prime', workspace, 'settings:mcp-status', workspace)
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    void reload()
  }, [reload, resolved.value])

  const loginFlow = useLoginFlow((ok) => {
    if (ok) void reload()
  })

  const authenticate = async (name: string, action: McpAuthenticationAction) => {
    setError(null)
    try {
      if (action === 'login' || action === 'token') {
        const label = statuses.find((status) => status.name === name)?.label ?? name
        await loginFlow.start(
          { id: `mcp:${name}`, name: label },
          action === 'token' ? 'api_key' : 'oauth',
          { engine: 'prime', cwd: workspace ?? undefined }
        )
        return
      }
      const nextRunId = await settingsInvokeForFolder(
        'prime',
        workspace,
        'settings:mcp-auth',
        workspace,
        name,
        action
      )
      useRuns.getState().label(nextRunId, `Signing out of ${name}`, 'prime')
      setRunId(nextRunId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const openDocs = async (url: string) => {
    try {
      await invoke('sys:open-external', url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    if (run?.status === 'ok') void reload()
  }, [run?.status, reload])

  const writeServer = async (name: string, config: JsonObject | undefined) => {
    const snapshot = await settingsInvokeForFolder('prime', workspace, 'settings:set', {
      scope,
      cwd: workspace,
      path: ['mcpServers', name],
      value: config
    })
    if (useSettings.getState().engine === 'prime') replaceSnapshot(snapshot)
    const affected =
      scope === 'project' ? { agentIds: agentsForEngine('prime', workspace), patch: {} } : undefined
    afterEngineConfigChange('restart', affected, 'prime', 'MCP servers changed.')
    await reload()
  }

  const save = async (name: string, config: JsonObject) => {
    const next =
      scope === 'project' && editing?.name
        ? projectServerOverlay(
            editing.config,
            config,
            objectValue(projectServers[name]),
            objectValue(globalServers[name])
          )
        : config
    await writeServer(name, next)
  }

  const updateServer = async (name: string, config: JsonObject | undefined) => {
    setWriting(true)
    setError(null)
    try {
      await writeServer(name, config)
      setRemoving(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWriting(false)
    }
  }

  const native = statuses.filter((status) => servers[status.name] === undefined)
  const setUp = native.filter((status) => SET_UP_STATES.has(status.state) || live.has(status.name))
  const catalog = native.filter((status) => !setUp.includes(status))
  const nativeRow = (status: McpServerStatus) => {
    const liveEntry = live.get(status.name)
    const actions = connectionActions({
      name: status.name,
      status,
      oauth: status.usesOAuth === true,
      onAuthenticate: authenticate,
      onOpenDocs: openDocs
    })
    return (
      <Row
        key={status.name}
        label={status.label ?? status.name}
        description={status.error ?? status.description}
        badges={<ServerState live={liveEntry} configured={configuredState(status.state)} />}
        below={
          actions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          ) : undefined
        }
      >
        <ReconnectButton name={status.label ?? status.name} live={liveEntry} />
      </Row>
    )
  }

  return (
    <>
      <LoginDialog flow={loginFlow} />
      <div className="mb-5 flex items-center justify-end gap-2">
        <Button size="sm" leading={<RefreshCw />} loading={loading} onClick={() => void reload()}>
          Refresh
        </Button>
        <Button
          size="sm"
          variant="primary"
          leading={<Plus />}
          onClick={() => setEditing({ name: null, config: { type: 'stdio', enabled: true } })}
        >
          Add server
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {run && <ProcessLog run={run} onDismiss={() => setRunId(null)} className="mb-5" />}
      <Group title={scope === 'project' ? 'Project servers' : 'Global servers'}>
        {Object.keys(servers).length === 0 && (
          <Note>
            Add a local executable or an HTTP server to give Engine 2 access to its tools.
          </Note>
        )}
        {Object.entries(servers).map(([name, value]) => {
          const config = objectValue(value)
          const status = statuses.find((item) => item.name === name)
          const inherited = scope === 'project' && projectServers[name] === undefined
          const liveEntry = config.enabled === false ? undefined : live.get(name)
          const actions = connectionActions({
            name,
            status,
            oauth: status?.usesOAuth ?? (config.type === 'http' && config.oauth === true),
            onAuthenticate: authenticate,
            onOpenDocs: openDocs
          })
          return (
            <Row
              key={name}
              label={name}
              description={
                status?.error ??
                (config.type === 'http' ? stringValue(config.url) : stringValue(config.command))
              }
              badges={
                <ServerState
                  live={liveEntry}
                  configured={configuredState(config.enabled === false ? 'disabled' : status?.state)}
                />
              }
              below={
                actions.length > 0 || removing === name ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {actions}
                    {removing === name && (
                      <>
                        <span className="text-xs text-fg-2">
                          {scope === 'project'
                            ? 'Remove this project override?'
                            : 'Remove this configuration?'}
                        </span>
                        <Button
                          size="xs"
                          variant="danger"
                          loading={writing}
                          onClick={() => void updateServer(name, undefined)}
                        >
                          Remove
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setRemoving(null)}>
                          Keep
                        </Button>
                      </>
                    )}
                  </div>
                ) : undefined
              }
            >
              <div className="flex items-center gap-2">
                <ReconnectButton name={name} live={liveEntry} />
                <IconButton label={`Edit ${name}`} onClick={() => setEditing({ name, config })}>
                  <Pencil />
                </IconButton>
                <IconButton
                  label={inherited ? `${name} is inherited from global settings` : `Remove ${name}`}
                  disabled={inherited || writing}
                  onClick={() => setRemoving(name)}
                >
                  <Trash2 />
                </IconButton>
                <Switch
                  aria-label={`Enable ${name}`}
                  checked={config.enabled !== false}
                  disabled={writing}
                  onCheckedChange={(enabled) =>
                    void updateServer(name, {
                      ...(scope === 'project' ? objectValue(projectServers[name]) : config),
                      enabled
                    })
                  }
                />
              </div>
            </Row>
          )
        })}
      </Group>
      {native.length > 0 && (
        <Group title="Native connections">
          {setUp.length === 0 && <Note>No catalog service is connected yet.</Note>}
          {setUp.map(nativeRow)}
          {catalog.length > 0 && (
            <button
              type="button"
              aria-expanded={catalogOpen}
              onClick={() => setCatalogOpen((open) => !open)}
              className="flex h-10 w-full items-center gap-1.5 px-4 text-left text-sm text-fg-2 hover:text-fg"
            >
              <ChevronRight
                className={cn('size-3.5 transition-transform', catalogOpen && 'rotate-90')}
              />
              {catalogOpen ? 'Hide' : 'Show'} {plural(catalog.length, 'more service')} you can
              connect
            </button>
          )}
          {catalogOpen && catalog.map(nativeRow)}
        </Group>
      )}
      {editing && (
        <PrimeMcpEditor
          name={editing.name}
          initial={editing.config}
          project={scope === 'project'}
          names={Object.keys(servers)}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </>
  )
}
