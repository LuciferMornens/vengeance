import { strict as assert } from 'node:assert'
import {
  ADAPTER_MCP_STATUS_EVENT,
  chooseStatus,
  ENGINE_MCP_REQUEST_EVENT,
  ENGINE_MCP_STATE_EVENT,
  fromAdapterSnapshot,
  fromEngineState,
  isMcpLiveAction,
  MCP_STATUS_KEY as BRIDGE_MCP_STATUS_KEY
} from '../../resources/bridge/mcp-status-core'
import type { AgentInfo, BridgeRequest } from '../../src/shared/api/engine'
import {
  MCP_STATUS_KEY,
  mcpLiveCounts,
  mcpSwitchAction,
  parseMcpLiveStatus,
  type McpLiveServer,
  type McpLiveStatus
} from '../../src/shared/api/mcp'
import { callBridge } from '../../src/main/engine/bridge'
import { MockEngineProcess } from '../../src/main/engine/mock'
import { primeMcp } from '../../src/main/engine/prime/bridge'
import { primeLiveMcpStatus, PrimeMcpTimeouts } from '../../src/main/engine/prime/mcp-live'
import { PrimeMockEngineProcess } from '../../src/main/engine/prime/mock'
import { PrimeCommandError } from '../../src/main/engine/prime/transport'
import { reduceAgentEvent } from '../../src/renderer/store/agent-reducer'
import { createAgentState } from '../../src/renderer/store/agent-state'
import { mergeWorkspaceMcp, workspaceStateText } from '../../src/renderer/features/mcp/status'
import { check } from './harness'

const CWD = 'C:\\Users\\dev\\projects\\aurora'

await check('MCP status: the bridge and the app share the status key and event names', () => {
  assert.equal(BRIDGE_MCP_STATUS_KEY, MCP_STATUS_KEY)
  assert.ok(MCP_STATUS_KEY.startsWith('__vengeance:'), 'hidden like every bridge status')
  assert.equal(ENGINE_MCP_STATE_EVENT, 'mcp:state')
  assert.equal(ENGINE_MCP_REQUEST_EVENT, 'mcp:request')
  assert.equal(ADAPTER_MCP_STATUS_EVENT, 'pi-mcp-adapter/status/v1')
})

await check('MCP status: the built-in extension state in the app words', () => {
  const status = fromEngineState({
    version: 1,
    configErrors: ['mcp.json: unexpected token', ''],
    servers: [
      { name: 'files', state: 'connected', toolCount: 5, error: 'stale', oauth: false },
      { name: 'boot', state: 'starting' },
      { name: 'dial', state: 'connecting', error: 'MCP error -32000: Connection closed' },
      { name: 'idle', state: 'disconnected', toolCount: 3 },
      { name: 'done', state: 'closed' },
      { name: 'auth', state: 'needs-auth', oauth: true, error: 'Sign in first' },
      { name: 'down', state: 'failed', error: 'spawn npx ENOENT' },
      { name: 'off', state: 'disabled' },
      { name: 'odd', state: 'exploded' },
      { state: 'connected' }
    ].map((server) => ({ saves: 'global', ...server }))
  })
  const switchable = { toggle: true, saves: 'global' } as const
  assert.deepEqual(status, {
    source: 'engine',
    errors: ['mcp.json: unexpected token'],
    live: true,
    servers: [
      { name: 'files', state: 'connected', toolCount: 5, oauth: false, ...switchable },
      { name: 'boot', state: 'connecting', oauth: false, ...switchable },
      { name: 'dial', state: 'connecting', oauth: false, ...switchable },
      { name: 'idle', state: 'idle', note: 'Reconnects on next use', oauth: false, ...switchable },
      { name: 'done', state: 'idle', oauth: false, ...switchable },
      { name: 'auth', state: 'needs-auth', error: 'Sign in first', oauth: true, ...switchable },
      { name: 'down', state: 'failed', error: 'spawn npx ENOENT', oauth: false, ...switchable },
      { name: 'off', state: 'disabled', oauth: false, ...switchable }
    ]
  })
  assert.equal(fromEngineState({ version: 2, servers: [] }), undefined, 'a newer contract is not guessed')
  assert.equal(fromEngineState(null), undefined)
})

await check('MCP status: the Engine switch saves for the folder alone whenever it can, else says where', () => {
  const status = fromEngineState({
    version: 1,
    servers: [
      { name: 'here', state: 'connected', scope: 'global', saves: 'global', projectConfig: '/w/.pi/mcp.json' },
      { name: 'everywhere', state: 'connected', scope: 'global', saves: 'global' },
      { name: 'overridden', state: 'disabled', scope: 'global', saves: 'project' },
      { name: 'local', state: 'connected', scope: 'project', saves: 'project' },
      { name: 'plugin', state: 'connected', scope: 'extension', saves: 'session' },
      { name: 'unsaid', state: 'connected' },
      { name: 'odd', state: 'connected', saves: 'cloud', projectConfig: '/w/.pi/mcp.json' }
    ]
  })
  const servers = new Map(status?.servers.map((server) => [server.name, server]))
  const target = (name: string): Partial<McpLiveServer> => {
    const { toggle, saves, projectOverride } = servers.get(name) ?? {}
    return { toggle, saves, projectOverride }
  }
  assert.deepEqual(target('here'), { toggle: true, saves: 'project', projectOverride: true })
  assert.deepEqual(target('everywhere'), { toggle: true, saves: 'global', projectOverride: undefined })
  assert.deepEqual(target('overridden'), { toggle: true, saves: 'project', projectOverride: undefined })
  assert.deepEqual(target('local'), { toggle: true, saves: 'project', projectOverride: undefined })
  assert.deepEqual(target('plugin'), { toggle: true, saves: 'session', projectOverride: undefined })
  for (const name of ['unsaid', 'odd']) {
    assert.deepEqual(target(name), { toggle: false, saves: undefined, projectOverride: undefined }, name)
  }

  const action = (name: string, on: boolean) => mcpSwitchAction(servers.get(name)!, on)
  assert.equal(action('here', false), 'disable-project', 'a global server is turned off for this folder')
  assert.equal(action('here', true), 'enable-project')
  assert.equal(action('everywhere', false), 'disable')
  assert.equal(action('overridden', true), 'enable', 'its project override already holds the state')
  assert.equal(action('plugin', false), 'disable')
  for (const name of ['enable-project', 'disable-project']) assert.ok(isMcpLiveAction(name), name)
  assert.equal(isMcpLiveAction('restart'), false)
})

await check('MCP status: pi-mcp-adapter snapshots in the app words, never toggled from the chip', () => {
  const status = fromAdapterSnapshot({
    version: 1,
    servers: [
      { name: 'live', status: 'connected', toolCount: 4 },
      { name: 'warm', status: 'cached', toolCount: 2 },
      { name: 'lazy', status: 'not-connected' },
      { name: 'auth', status: 'needs-auth' },
      { name: 'down', status: 'failed', failedAgoSeconds: 30 },
      { name: 'late', status: 'failed', failedAgoSeconds: 150 },
      { name: 'trust', status: 'blocked', blockedReason: 'Trust the project first' },
      { name: 'off', status: 'disabled' }
    ]
  })
  assert.deepEqual(status?.servers, [
    { name: 'live', state: 'connected', toolCount: 4, oauth: false, toggle: false },
    { name: 'warm', state: 'idle', note: 'Connects on first use', toolCount: 2, oauth: false, toggle: false },
    { name: 'lazy', state: 'idle', note: 'Connects on first use', oauth: false, toggle: false },
    { name: 'auth', state: 'needs-auth', oauth: true, toggle: false },
    {
      name: 'down',
      state: 'failed',
      error: 'Failed moments ago; retries after a pause',
      oauth: false,
      toggle: false
    },
    { name: 'late', state: 'failed', error: 'Failed 3 min ago; retries after a pause', oauth: false, toggle: false },
    { name: 'trust', state: 'blocked', error: 'Trust the project first', oauth: false, toggle: false },
    { name: 'off', state: 'disabled', oauth: false, toggle: false }
  ])
  assert.equal(status?.source, 'adapter')
})

await check('MCP status: the built-in extension wins while it has servers, else the adapter', () => {
  const engine = fromEngineState({ version: 1, servers: [{ name: 'a', state: 'connected' }] })
  const emptyEngine = fromEngineState({ version: 1, servers: [] })
  const adapter = fromAdapterSnapshot({ version: 1, servers: [{ name: 'b', status: 'connected' }] })
  assert.equal(chooseStatus(engine, adapter), engine)
  assert.equal(chooseStatus(emptyEngine, adapter), adapter, 'the adapter replaces an empty built-in')
  assert.equal(chooseStatus(emptyEngine, undefined), emptyEngine)
  assert.equal(chooseStatus(undefined, undefined), undefined)
  const errorsOnly = fromEngineState({ version: 1, servers: [], configErrors: ['mcp.json: oops'] })
  const emptyAdapter = fromAdapterSnapshot({ version: 1, servers: [] })
  assert.equal(chooseStatus(errorsOnly, adapter), adapter, 'configuration errors alone do not hide the adapter')
  assert.equal(chooseStatus(errorsOnly, emptyAdapter), errorsOnly, 'without adapter servers the errors show')
})

await check('MCP status: counts leave switched-off servers out and flag what needs the user', () => {
  const status: McpLiveStatus = {
    source: 'engine',
    errors: [],
    live: true,
    servers: [
      { name: 'a', state: 'connected', oauth: false, toggle: true },
      { name: 'b', state: 'failed', oauth: false, toggle: true },
      { name: 'c', state: 'needs-auth', oauth: true, toggle: true },
      { name: 'd', state: 'idle', oauth: false, toggle: true },
      { name: 'e', state: 'disabled', oauth: false, toggle: true },
      { name: 'f', state: 'blocked', oauth: false, toggle: false }
    ]
  }
  assert.deepEqual(mcpLiveCounts(status), { enabled: 4, connected: 1, attention: 2 })
})

await check('MCP status: a Settings row leads with the worst state across the folder sessions', () => {
  const live = (...servers: McpLiveServer[]): McpLiveStatus => ({
    source: 'engine',
    errors: [],
    live: true,
    servers
  })
  const files = (state: McpLiveServer['state'], extra: Partial<McpLiveServer> = {}) =>
    live({ name: 'files', state, oauth: false, toggle: true, ...extra })
  const row = (statuses: Array<McpLiveStatus | undefined>) => {
    const entry = mergeWorkspaceMcp(
      statuses.map((_, index) => `a${index}`),
      statuses
    ).get('files')
    assert.ok(entry, 'the row exists')
    return entry
  }

  const connected = files('connected', { toolCount: 5 })
  const failed = files('failed', { error: 'Error: spawn npx ENOENT\n    at foo' })
  for (const statuses of [
    [connected, failed],
    [failed, connected]
  ]) {
    const entry = row(statuses)
    assert.equal(entry.server.state, 'failed', 'the failing session gives the dot and the details')
    assert.equal(entry.agents.length, 2)
    assert.deepEqual(
      entry.agents.map((agent) => agent.server.state),
      statuses.map((status) => status.servers[0]!.state),
      'each session keeps its own copy'
    )
    assert.equal(
      workspaceStateText(entry),
      'Failed in 1 of 2 open sessions (connected in 1): spawn npx ENOENT'
    )
  }

  assert.equal(
    workspaceStateText(
      row([
        files('idle', { note: 'Connects on first use' }),
        files('connected', { toolCount: 2 }),
        undefined,
        files('disabled')
      ])
    ),
    'Connects on first use in 1 of 3 open sessions (connected in 1, off in 1)'
  )
  assert.equal(
    workspaceStateText(row([files('disabled'), files('connected', { toolCount: 1 })])),
    'Connected · 1 tool in 1 of 2 open sessions (off in 1)'
  )
  const twoTools = files('connected', { toolCount: 2 })
  assert.equal(workspaceStateText(row([twoTools, twoTools])), 'Connected · 2 tools in 2 open sessions')
  assert.equal(
    workspaceStateText(row([files('connected', { toolCount: 3 })])),
    'Connected · 3 tools in the open session'
  )
  assert.equal(workspaceStateText(row([files('disabled'), files('disabled')])), 'Off')
})

await check('MCP status: Engine 2 connections with the kernel listing', () => {
  const connections = {
    services: [
      { serviceId: 'files', source: 'user', connectionStatus: 'connected', usesOauth: false },
      {
        serviceId: 'notion',
        source: 'catalog',
        connectionStatus: 'connected',
        usesOauth: true,
        connectionIds: ['notion-workspace']
      },
      { serviceId: 'slack', source: 'catalog', connectionStatus: 'not_connected', usesOauth: true },
      {
        serviceId: 'drive',
        source: 'catalog',
        connectionStatus: 'not_connected',
        usesOauth: true,
        loginPending: true,
        setupHint: 'Finish signing in'
      },
      { serviceId: 'jira', source: 'catalog', connectionStatus: 'pending', usesOauth: true },
      { serviceId: 'vault', source: 'user', connectionStatus: 'connected' },
      { serviceId: 'paused', source: 'user', connectionStatus: 'disabled', toolCount: 2 },
      { serviceId: 'cold', source: 'user', connectionStatus: 'connected', toolCount: 7 }
    ]
  }
  const status = primeLiveMcpStatus(connections, {
    kernelRunning: true,
    servers: [
      { server: 'files', tools: [{ name: 'read' }, { name: 'write' }], error: null },
      { server: 'notion-workspace', tools: [{ name: 'search' }], error: null },
      { server: 'vault', tools: null, error: 'McpCredentialsUnavailable: vault needs a token' },
      { server: 'extra', tools: null, error: 'McpStartupError: spawn uvx ENOENT' }
    ]
  })
  assert.deepEqual(status, {
    source: 'prime',
    errors: [],
    live: true,
    servers: [
      { name: 'files', state: 'connected', toolCount: 2, oauth: false, toggle: false },
      { name: 'notion', state: 'connected', toolCount: 1, oauth: true, toggle: false },
      {
        name: 'drive',
        state: 'needs-auth',
        error: 'Finish signing in',
        oauth: true,
        toggle: false,
        reconnectable: false
      },
      {
        name: 'jira',
        state: 'idle',
        note: 'Signed in; not verified yet',
        oauth: true,
        toggle: false,
        reconnectable: false
      },
      { name: 'vault', state: 'needs-auth', error: 'vault needs a token', oauth: false, toggle: false },
      { name: 'paused', state: 'disabled', oauth: false, toggle: false, reconnectable: false },
      {
        name: 'cold',
        state: 'idle',
        note: 'Connects on first use',
        toolCount: 7,
        oauth: false,
        toggle: false,
        reconnectable: false
      },
      { name: 'extra', state: 'failed', error: 'spawn uvx ENOENT', oauth: false, toggle: false }
    ]
  })

  const configured = primeLiveMcpStatus(connections, { kernelRunning: false, servers: [] })
  assert.equal(configured.live, false, 'without a running kernel the states are configured ones')
  assert.deepEqual(configured.servers.find((server) => server.name === 'files'), {
    name: 'files',
    state: 'idle',
    note: 'Not started yet',
    oauth: false,
    toggle: false,
    reconnectable: false
  })
  assert.ok(
    configured.servers.every((server) => server.reconnectable === false),
    'nothing to reconnect before the kernel runs'
  )
})

await check('MCP status: Engine 2 reads a first bare listing timeout as connecting', () => {
  const status = primeLiveMcpStatus(
    {
      services: [
        { serviceId: 'slow', source: 'user', connectionStatus: 'connected' },
        { serviceId: 'late', source: 'user', connectionStatus: 'connected' },
        { serviceId: 'bare', source: 'user', connectionStatus: 'connected' },
        { serviceId: 'auth', source: 'user', connectionStatus: 'connected' }
      ]
    },
    {
      kernelRunning: true,
      servers: [
        { server: 'slow', tools: null, error: 'TimeoutError: ' },
        { server: 'late', tools: null, error: 'TimeoutError: read timed out after 60 s' },
        { server: 'bare', tools: null, error: 'CancelledError: ' },
        { server: 'auth', tools: null, error: 'McpCredentialsUnavailable: ' }
      ]
    }
  )
  assert.deepEqual(
    status.servers.map(({ name, state, error }) => ({ name, state, error })),
    [
      { name: 'slow', state: 'connecting', error: undefined },
      { name: 'late', state: 'failed', error: 'read timed out after 60 s' },
      { name: 'bare', state: 'failed', error: 'CancelledError' },
      { name: 'auth', state: 'needs-auth', error: undefined }
    ]
  )
  assert.ok(
    status.servers.every((server) => server.reconnectable === undefined),
    'the kernel runs them all'
  )
})

await check('MCP status: Engine 2 shows configured states only for builds before 0024', async () => {
  const reading = (failure: Error) => async (type: string) => {
    if (type === 'get_mcp_connections') {
      return { services: [{ serviceId: 'files', source: 'user', connectionStatus: 'connected' }] }
    }
    throw failure
  }
  const older = await primeMcp(
    { op: 'mcp' },
    reading(new PrimeCommandError('Unknown daemon command: get_mcp_status')),
    new PrimeMcpTimeouts()
  )
  assert.equal(older.live, false)
  await assert.rejects(
    primeMcp(
      { op: 'mcp' },
      reading(new PrimeCommandError('MCP status listing did not settle')),
      new PrimeMcpTimeouts()
    ),
    /did not settle/,
    'a running kernel whose listing failed is not reported as not started'
  )
})

await check('MCP status: an Engine 2 reconnect without a running kernel says so', async () => {
  const commands: string[] = []
  const nativeCommand = async (type: string) => {
    commands.push(type)
    return type === 'get_mcp_connections' ? { services: [] } : { kernelRunning: false, servers: [] }
  }
  const timeouts = new PrimeMcpTimeouts()
  await assert.rejects(
    primeMcp({ op: 'mcp', action: 'reconnect', server: 'files' }, nativeCommand, timeouts),
    /has not started this conversation’s Python runtime yet/
  )
  assert.deepEqual(commands, ['get_mcp_connections', 'reconnect_mcp_server'])
  const status = await primeMcp({ op: 'mcp' }, nativeCommand, timeouts)
  assert.equal(status.live, false, 'reading the status still works')
})

await check('MCP status: an Engine 2 reconnect reaches each connection of its row', async () => {
  const reconnected: string[] = []
  const connections = {
    services: [
      {
        serviceId: 'linear',
        source: 'catalog',
        connectionStatus: 'connected',
        connectionIds: ['linear-1', 'linear-2']
      },
      { serviceId: 'later', source: 'user', connectionStatus: 'connected' }
    ]
  }
  const running = new Set(['linear-2'])
  const nativeCommand = async (type: string, payload?: Record<string, unknown>) => {
    if (type === 'get_mcp_connections') return connections
    if (type === 'get_mcp_status') {
      return {
        kernelRunning: true,
        servers: [...running].map((server) => ({
          server,
          tools: [{ name: 'issues' }],
          error: null
        }))
      }
    }
    const server = String(payload?.server)
    if (!running.has(server)) {
      throw new PrimeCommandError(`MCP server ${server} is not enabled in this session`)
    }
    reconnected.push(server)
    return { kernelRunning: true, servers: [{ server, tools: [{ name: 'issues' }], error: null }] }
  }
  const timeouts = new PrimeMcpTimeouts()
  const reconnect = (server: string) =>
    primeMcp({ op: 'mcp', action: 'reconnect', server }, nativeCommand, timeouts)
  const status = await reconnect('linear')
  assert.deepEqual(reconnected, ['linear-2'], 'the account the kernel runs, not the service id')
  assert.equal(status.servers.find((server) => server.name === 'linear')?.state, 'connected')
  assert.equal(status.servers.find((server) => server.name === 'later')?.reconnectable, false)
  await assert.rejects(reconnect('later'), /This conversation does not run later/)
  running.add('linear-1')
  reconnected.length = 0
  await reconnect('linear')
  assert.deepEqual(reconnected.sort(), ['linear-1', 'linear-2'], 'each account of the service')
})

await check('MCP status: an Engine 2 server that times out again reads as failed', async () => {
  const connections = {
    services: [
      { serviceId: 'hung', source: 'user', connectionStatus: 'connected' },
      { serviceId: 'files', source: 'user', connectionStatus: 'connected' }
    ]
  }
  let hungAnswers = false
  let kernelRunning = true
  const payloads: Array<[string, Record<string, unknown> | undefined]> = []
  const listing = (server: string) =>
    server === 'hung' && !hungAnswers
      ? { server, tools: null, error: 'TimeoutError: ' }
      : { server, tools: [{ name: 'read' }], error: null }
  const nativeCommand = async (type: string, payload?: Record<string, unknown>) => {
    payloads.push([type, payload])
    if (type === 'get_mcp_connections') return connections
    if (!kernelRunning) return { kernelRunning: false, servers: [] }
    if (type === 'get_mcp_status') {
      return { kernelRunning: true, servers: ['hung', 'files'].map(listing) }
    }
    return { kernelRunning: true, servers: [listing(String(payload?.server))] }
  }
  const timeouts = new PrimeMcpTimeouts()
  const hung = async (request: Extract<BridgeRequest, { op: 'mcp' }> = { op: 'mcp' }) =>
    (await primeMcp(request, nativeCommand, timeouts)).servers.find(
      (server) => server.name === 'hung'
    )
  const state = (server: McpLiveServer | undefined) => ({
    state: server?.state,
    error: server?.error
  })
  const stalled = { state: 'failed', error: 'Did not answer within 10 s; Reconnect gives it 20 s.' }

  assert.deepEqual(
    state(await hung()),
    { state: 'connecting', error: undefined },
    'it may be opening'
  )
  assert.deepEqual(state(await hung()), stalled, 'the next listing timed out as well')
  assert.deepEqual(state(await hung()), stalled)
  assert.deepEqual(
    payloads.filter(([type]) => type === 'get_mcp_status').map(([, payload]) => payload),
    [{ timeoutMs: 10_000 }, { timeoutMs: 10_000 }, { timeoutMs: 10_000 }]
  )

  // A Reconnect gives the server the longer bound; if that times out too, its read reads failed.
  payloads.length = 0
  assert.deepEqual(state(await hung({ op: 'mcp', action: 'reconnect', server: 'hung' })), stalled)
  assert.deepEqual(payloads.find(([type]) => type === 'reconnect_mcp_server')?.[1], {
    server: 'hung',
    timeoutMs: 20_000
  })
  hungAnswers = true
  assert.equal((await hung({ op: 'mcp', action: 'reconnect', server: 'hung' }))?.state, 'connected')
  hungAnswers = false
  assert.equal((await hung())?.state, 'connecting', 'once it answered, a timeout starts over')
  kernelRunning = false
  assert.equal((await hung())?.state, 'idle')
  kernelRunning = true
  assert.equal((await hung())?.state, 'connecting', 'a new kernel starts over')
  timeouts.clear()
  assert.equal((await hung())?.state, 'connecting', 'so does another session')
})

await check('reducer: the MCP status parses into agent state and is never a visible chip', () => {
  const info: AgentInfo = {
    agentId: 'a1',
    engine: 'pi',
    cwd: CWD,
    status: 'ready',
    mock: true,
    busy: false,
    bridge: true,
    createdAt: 0,
    args: { cwd: CWD }
  }
  const published = (statusText: string) =>
    reduceAgentEvent(createAgentState(info), {
      type: 'extension_ui_request',
      id: 'm',
      method: 'setStatus',
      statusKey: MCP_STATUS_KEY,
      statusText
    })
  const valid = fromEngineState({ version: 1, servers: [{ name: 'files', state: 'connected', toolCount: 1 }] })
  const parsed = published(JSON.stringify(valid))
  assert.deepEqual(parsed.mcp, valid)
  assert.deepEqual(parsed.ext.statuses, {}, 'never shown as a status')
  for (const malformed of ['{', JSON.stringify({ source: 'other', servers: [], errors: [] })]) {
    assert.equal(published(malformed).mcp, undefined, malformed)
  }
  const unknownState = published(
    JSON.stringify({ source: 'engine', servers: [{ name: 'x', state: 'exploded' }], errors: [] })
  )
  assert.deepEqual(unknownState.mcp?.servers, [], 'a server in an unknown state is left out')
  assert.equal(parseMcpLiveStatus(JSON.stringify({ ...valid, live: false }))?.live, false)
})

await check('Engine mock: the bridge reports, reconnects and toggles MCP servers for the folder', async () => {
  const mock = new MockEngineProcess({ cwd: CWD })
  const published: McpLiveStatus[] = []
  mock.on('event', (event) => {
    if (
      event.type === 'extension_ui_request' &&
      event.method === 'setStatus' &&
      event.statusKey === MCP_STATUS_KEY &&
      event.statusText
    ) {
      published.push(JSON.parse(event.statusText) as McpLiveStatus)
    }
  })
  await mock.start()
  try {
    const read = await callBridge(mock, { op: 'mcp' }, 1000)
    assert.equal(read?.source, 'engine')
    assert.deepEqual(
      read?.servers.map((server) => [server.name, server.state]),
      [
        ['filesystem', 'connected'],
        ['github', 'connected'],
        ['sentry', 'needs-auth'],
        ['linear', 'failed'],
        ['postgres', 'disabled']
      ]
    )
    assert.ok(published.length > 0, 'the status is published at start')
    const failed = read?.servers.find((server) => server.name === 'linear')
    assert.match(failed?.error ?? '', /Connection closed/)
    const reconnecting = await callBridge(mock, { op: 'mcp', action: 'reconnect', server: 'linear' }, 1000)
    const connecting = reconnecting?.servers.find((server) => server.name === 'linear')
    assert.equal(connecting?.state, 'connecting')
    assert.equal(connecting?.error, undefined, 'the failure before the reconnect is stale')
    // The mock trusts its folder: every global server turns on or off there alone.
    assert.ok(read?.servers.every((server) => server.projectOverride && server.saves === 'project'))
    const enabled = await callBridge(
      mock,
      { op: 'mcp', action: 'enable-project', server: 'postgres' },
      1000
    )
    const postgres = enabled?.servers.find((server) => server.name === 'postgres')
    assert.equal(postgres?.state, 'connected')
    assert.equal(postgres?.saves, 'project')
    assert.equal(postgres?.projectOverride, undefined, 'its project override now holds its state')
    await assert.rejects(
      callBridge(mock, { op: 'mcp', action: 'disable-project', server: 'postgres' }, 1000),
      /for the project alone/
    )
    await assert.rejects(
      callBridge(mock, { op: 'mcp', action: 'logout', server: 'filesystem' }, 1000),
      /does not use OAuth/
    )
    assert.equal(published.at(-1)?.servers.find((server) => server.name === 'postgres')?.state, 'connected')
  } finally {
    await mock.stop()
  }
})

await check('Engine 2 mock: the bridge reads live status and reconnects, but never toggles', async () => {
  const prime = new PrimeMockEngineProcess({ cwd: CWD, engine: 'prime' })
  await prime.start()
  try {
    const read = (await prime.bridge({ op: 'mcp' })) as McpLiveStatus
    assert.equal(read.source, 'prime')
    assert.equal(read.live, true)
    assert.deepEqual(
      read.servers.map((server) => [server.name, server.state, server.toolCount]),
      [
        ['filesystem', 'connected', 5],
        ['github', 'connected', 4],
        ['sentry', 'needs-auth', undefined],
        ['linear', 'failed', undefined],
        ['postgres', 'disabled', undefined]
      ]
    )
    assert.ok(read.servers.every((server) => !server.toggle), 'Engine 2 toggles servers in Settings')
    const reconnecting = (await prime.bridge({ op: 'mcp', action: 'reconnect', server: 'linear' })) as McpLiveStatus
    assert.equal(reconnecting.servers.find((server) => server.name === 'linear')?.state, 'connected')
    await assert.rejects(prime.bridge({ op: 'mcp', action: 'disable', server: 'github' }), /in Settings/)
    await assert.rejects(prime.bridge({ op: 'mcp', action: 'reconnect' }), /Choose the MCP server/)
  } finally {
    await prime.stop()
  }
})
