import { strict as assert } from 'node:assert'
import {
  chatGptCatalogRequest,
  costMultiplier,
  effectiveMode,
  isRequestFor,
  parseChatGptCatalog,
  reportedMode,
  savedMode,
  settleSpeedRequest,
  SPEED_DEFAULT_ENV as CORE_DEFAULT_ENV,
  SPEED_ENTRY as CORE_ENTRY,
  SPEED_STATUS_KEY as CORE_STATUS_KEY,
  speedOffer,
  speedRefusal,
  speedRoute,
  speedState,
  startSpeedRequest,
  withSpeed,
  type SpeedRequest,
  type SpeedResponse,
  type SpeedUsage
} from '../../resources/bridge/speed-mode-core'
import {
  SPEED_DEFAULT_ENV,
  SPEED_ENTRY,
  SPEED_STATUS_KEY,
  type SpeedState
} from '../../src/shared/api/speed'
import type { AgentInfo } from '../../src/shared/api/engine'
import type { EngineEvent } from '../../src/shared/engine-types'
import { reduceAgentEvent } from '../../src/renderer/store/agent-reducer'
import { createAgentState } from '../../src/renderer/store/agent-state'
import { callBridge } from '../../src/main/engine/bridge'
import type { EngineHandle } from '../../src/main/engine/handle'
import { MockEngineProcess } from '../../src/main/engine/mock'
import { PrimeMockEngineProcess } from '../../src/main/engine/prime/mock'
import { PrimeSpeedControl, primeSpeedOffer } from '../../src/main/engine/prime/speed'
import { check } from './harness'

const CWD = 'C:\\Users\\dev\\projects\\aurora'

/** Every `SpeedState` the engine published on its hidden status key, and its native tier events. */
function recordSpeed(engine: EngineHandle): { states: SpeedState[]; tiers: unknown[] } {
  const states: SpeedState[] = []
  const tiers: unknown[] = []
  engine.on('event', (event: EngineEvent) => {
    if (
      event.type === 'extension_ui_request' &&
      event.method === 'setStatus' &&
      event.statusKey === SPEED_STATUS_KEY &&
      event.statusText
    ) {
      states.push(JSON.parse(event.statusText) as SpeedState)
    } else if (event.type === 'engine_native_event' && event.name === 'service_tier_changed') {
      tiers.push((event.data as { serviceTier?: unknown }).serviceTier)
    }
  })
  return { states, tiers }
}

/** Engine 2's `bridge()` returns every operation's result union; `speed` answers a `SpeedState`. */
async function primeSpeed(
  prime: PrimeMockEngineProcess,
  mode?: SpeedState['requested']
): Promise<SpeedState> {
  return (await prime.bridge({ op: 'speed', mode })) as SpeedState
}

const near = (actual: number | undefined, expected: number, label: string) =>
  assert.ok(Math.abs((actual ?? NaN) - expected) < 1e-12, `${label}: ${actual} != ${expected}`)

async function setModel(engine: EngineHandle, provider: string, modelId: string): Promise<void> {
  const response = await engine.send({ type: 'set_model', provider, modelId })
  assert.ok(response.success, `set_model ${provider}/${modelId}`)
}

await check('Engine mock: the default speed, per-model options and the saved choice', async () => {
  const mock = new MockEngineProcess({ cwd: CWD }, { [SPEED_DEFAULT_ENV]: 'fast' })
  const { states } = recordSpeed(mock)
  await mock.start()
  assert.deepEqual(states.at(-1), { requested: 'fast', effective: 'standard', options: [] })

  await setModel(mock, 'openai', 'gpt-6.1-sol')
  assert.deepEqual(states.at(-1), {
    requested: 'fast',
    effective: 'fast',
    options: [
      { mode: 'fast', costMultiplier: 2 },
      { mode: 'ultrafast', costMultiplier: 6 }
    ]
  })

  const chosen = await callBridge(mock, { op: 'speed', mode: 'ultrafast' }, 1000)
  assert.equal(chosen.requested, 'ultrafast')
  assert.equal(chosen.effective, 'ultrafast')
  const entries = await mock.send({ type: 'get_entries' })
  assert.ok(entries.success && entries.command === 'get_entries')
  const saved = entries.data.entries.filter(
    (entry) => entry.type === 'custom' && entry.customType === 'vengeance-speed'
  )
  assert.deepEqual(
    saved.map((entry) => entry.type === 'custom' && entry.data),
    [{ mode: 'ultrafast' }]
  )

  await setModel(mock, 'anthropic', 'claude-opus-5-5')
  assert.equal(states.at(-1)?.requested, 'ultrafast', 'switching models keeps the choice')
  assert.equal(states.at(-1)?.effective, 'fast', 'Claude has no Ultrafast')

  const settled = new Promise<void>((resolve) =>
    mock.on('event', (event) => event.type === 'agent_settled' && resolve())
  )
  await mock.play({ script: 'short', prompt: 'hello', instant: true })
  await settled
  assert.deepEqual(states.at(-1)?.lastResponse, { mode: 'fast', confirmed: true })

  const read = await callBridge(mock, { op: 'speed' }, 1000)
  assert.equal(read.requested, 'ultrafast')
  await mock.stop()
})

await check(
  'Engine 2 mock: Fast maps onto the native priority tier and its eligibility',
  async () => {
    const prime = new PrimeMockEngineProcess({ cwd: CWD, engine: 'prime' })
    const { states, tiers } = recordSpeed(prime)
    await prime.start()

    await setModel(prime, 'openrouter', 'openai/gpt-5.5')
    assert.deepEqual(await primeSpeed(prime, 'fast'), {
      requested: 'fast',
      effective: 'fast',
      options: [{ mode: 'fast' }]
    })
    assert.deepEqual(tiers, ['priority'])

    for (const id of ['gpt-5.5', 'gpt-6.1-sol']) {
      await setModel(prime, 'openai', id)
      assert.deepEqual(
        await primeSpeed(prime),
        { requested: 'fast', effective: 'fast', ...speedOffer('openai-api-key', id) },
        id
      )
    }
    assert.equal((await primeSpeed(prime, 'ultrafast')).effective, 'ultrafast')
    await setModel(prime, 'openai', 'gpt-5.5')
    assert.deepEqual(await primeSpeed(prime), {
      requested: 'ultrafast',
      effective: 'fast',
      ...speedOffer('openai-api-key', 'gpt-5.5')
    })

    await setModel(prime, 'anthropic', 'claude-opus-5-5')
    const claude = await primeSpeed(prime, 'standard')
    assert.equal(claude.unavailableReason, "Engine 2 doesn't support Claude fast mode")
    assert.equal(claude.requested, 'standard')
    assert.deepEqual(states, [], 'Engine 2 publishes no bridge status')
    await prime.stop()
  }
)

await check('Engine mock: a refused Fast saves standard and publishes one notice', async () => {
  const mock = new MockEngineProcess({ cwd: CWD }, { [SPEED_DEFAULT_ENV]: 'fast' })
  const { states } = recordSpeed(mock)
  await mock.start()
  await setModel(mock, 'openai', 'gpt-6-sol')
  assert.equal(states.at(-1)?.effective, 'fast')
  const settled = new Promise<void>((resolve) =>
    mock.on('event', (event) => event.type === 'agent_settled' && resolve())
  )
  await mock.play({ script: 'short', prompt: 'hello', instant: true })
  await settled
  assert.deepEqual(states.at(-1)?.notice, {
    id: 1,
    text: 'Fast mode turned off: Unsupported service_tier: priority'
  })
  assert.equal(states.at(-1)?.requested, 'standard')
  const chosen = await callBridge(mock, { op: 'speed', mode: 'fast' }, 1000)
  assert.equal(chosen.notice, undefined, 'a new choice clears the notice')
  await mock.stop()
})

await check('reducer: the speed status parses into agent state; a malformed one hides it', () => {
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
  const published = (state: unknown) =>
    reduceAgentEvent(createAgentState(info), {
      type: 'extension_ui_request',
      id: 's',
      method: 'setStatus',
      statusKey: SPEED_STATUS_KEY,
      statusText: JSON.stringify(state)
    })
  const valid: SpeedState = {
    requested: 'ultrafast',
    effective: 'fast',
    options: [{ mode: 'fast', description: '2x speed', costMultiplier: 2 }, { mode: 'ultrafast' }]
  }
  const parsed = published(valid)
  assert.deepEqual(parsed.speed, valid)
  assert.deepEqual(parsed.ext.statuses, {}, 'never shown as a status')
  for (const option of [
    { mode: 'fast', costMultiplier: '2' },
    { mode: 'standard', costMultiplier: 1 },
    { mode: 'warp', costMultiplier: 2 },
    { mode: 'fast', description: 7 },
    null
  ]) {
    assert.equal(
      published({ ...valid, options: [option] }).speed,
      undefined,
      JSON.stringify(option)
    )
  }
})

await check(
  'Engine 2 saves Standard after a tier refusal and keeps ordinary rate limits separate',
  async () => {
    const prime = new PrimeMockEngineProcess({ cwd: CWD, engine: 'prime' })
    await prime.start()
    await setModel(prime, 'openai', 'gpt-6.1-sol')
    const control = new PrimeSpeedControl((type, payload) => prime.nativeCommand(type, payload))
    await control.read('ultrafast')
    const message = {
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      stopReason: 'error',
      errorMessage: '400 Unsupported service_tier: ultrafast'
    }
    control.accept({ type: 'message_end', message })
    const corrected = await control.read()
    assert.equal(corrected.requested, 'standard')
    assert.match(corrected.notice?.text ?? '', /Ultrafast mode turned off/)
    assert.equal((await primeSpeed(prime)).requested, 'standard')
    control.reset()
    await control.read('fast')
    control.accept({ type: 'message_end', message: { ...message, errorMessage: '429 Rate limit' } })
    assert.equal((await control.read()).requested, 'fast')
    assert.equal((await control.read()).notice, undefined)
    await prime.stop()
  }
)

await check('primeSpeedOffer: OpenRouter offers Fast without a price', () => {
  const routed = { provider: 'openrouter', api: 'openai-completions', id: 'openai/gpt-5.5' }
  assert.deepEqual(primeSpeedOffer(routed, [{ tier: 'priority' }]), { options: [{ mode: 'fast' }] })
})

const openai = (id: string) => ({ provider: 'openai', api: 'openai-responses', id })
const anthropic = (id: string) => ({ provider: 'anthropic', api: 'anthropic-messages', id })
const modes = (route: Parameters<typeof speedOffer>[0], id: string) =>
  speedOffer(route, id).options.map((option) => option.mode)

await check('speed core: the bridge and the app agree on its names', () => {
  assert.equal(CORE_ENTRY, SPEED_ENTRY)
  assert.equal(CORE_STATUS_KEY, SPEED_STATUS_KEY)
  assert.equal(CORE_DEFAULT_ENV, SPEED_DEFAULT_ENV)
})

await check('speedRoute: OpenAI Responses and Anthropic Messages by sign-in', () => {
  assert.equal(speedRoute(openai('gpt-5.5'), false), 'openai-api-key')
  assert.equal(speedRoute(openai('gpt-5.5'), true), 'chatgpt')
  const codex = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-5.5' }
  assert.equal(speedRoute(codex, true), 'chatgpt')
  assert.equal(speedRoute(anthropic('claude-opus-5-5'), false), 'anthropic-api-key')
  assert.equal(speedRoute(anthropic('claude-opus-5-5'), true), 'anthropic-subscription')
  const completions = { provider: 'openai', api: 'openai-completions', id: 'gpt-5.5' }
  assert.equal(speedRoute(completions, false), undefined)
  const bedrock = { provider: 'amazon-bedrock', api: 'bedrock-converse-stream', id: 'x' }
  assert.equal(speedRoute(bedrock, false), undefined)
})

await check('speedOffer: the OpenAI API key table', () => {
  assert.deepEqual(speedOffer('openai-api-key', 'gpt-6.1-sol').options, [
    { mode: 'fast', costMultiplier: 2 },
    { mode: 'ultrafast', costMultiplier: 6 }
  ])
  assert.deepEqual(speedOffer('openai-api-key', 'gpt-5.5').options, [
    { mode: 'fast', costMultiplier: 2.5 }
  ])
  assert.deepEqual(modes('openai-api-key', 'gpt-6-astra'), ['fast', 'ultrafast'])
  for (const id of ['gpt-4.1-nano', 'gpt-4o-2024-08-06', 'o3', 'o4-mini', 'gpt-5.3-codex']) {
    assert.deepEqual(modes('openai-api-key', id), ['fast'], id)
  }
  // Fast over Standard input $/MTok on the pricing page.
  const fastPrices: Array<[string, number]> = [
    ['gpt-5.4-mini', 1.5 / 0.75],
    ['gpt-5-mini', 0.45 / 0.25],
    ['gpt-4.1', 3.5 / 2],
    ['gpt-4.1-mini', 0.7 / 0.4],
    ['gpt-4.1-nano', 0.2 / 0.1],
    ['gpt-4o', 4.25 / 2.5],
    ['gpt-4o-2024-05-13', 8.75 / 5],
    ['gpt-4o-mini', 0.25 / 0.15],
    ['o3', 3.5 / 2],
    ['o4-mini', 2 / 1.1]
  ]
  for (const [id, multiplier] of fastPrices) {
    const price = speedOffer('openai-api-key', id).options[0]?.costMultiplier
    near(price, multiplier, `${id} Fast price`)
  }
  for (const id of [
    'gpt-4',
    'gpt-4-turbo',
    'gpt-5-pro',
    'gpt-5-nano',
    'gpt-5.3-codex-spark',
    'gpt-5-chat-latest',
    'o1',
    'o3-mini',
    'gpt-daybreak-blue-latest'
  ]) {
    assert.deepEqual(modes('openai-api-key', id), [], id)
  }
})

await check(
  'speedOffer: ChatGPT sign-in uses the account catalog, a built-in list until then',
  () => {
    assert.deepEqual(modes('chatgpt', 'gpt-6.1-sol'), ['fast'], 'no Ultrafast without the catalog')
    assert.deepEqual(modes('chatgpt', 'gpt-5.4'), [])
    const catalog = parseChatGptCatalog({
      models: [
        {
          slug: 'gpt-6.1-sol',
          service_tiers: [
            { id: 'priority', name: 'Fast', description: '2x speed, increased usage' }
          ]
        },
        { slug: 'gpt-6-astra', service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
        { slug: 'gpt-5.4', service_tiers: [], additional_speed_tiers: ['fast'] },
        { slug: 'gpt-6-sol', service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
        { slug: 'codex-auto-review', service_tiers: [{ id: 'priority' }] },
        { slug: 'gpt-daybreak-blue-latest', service_tiers: [] },
        { name: 'no slug' }
      ]
    })
    assert.ok(catalog)
    assert.deepEqual(speedOffer('chatgpt', 'gpt-6.1-sol', catalog).options, [
      { mode: 'fast', description: '2x speed, increased usage', costMultiplier: 2 }
    ])
    assert.deepEqual(speedOffer('chatgpt', 'gpt-6-astra', catalog).options, [
      { mode: 'fast', costMultiplier: 2 },
      { mode: 'ultrafast', costMultiplier: 6 }
    ])
    assert.deepEqual(speedOffer('chatgpt', 'gpt-5.4', catalog).options[0]?.mode, 'fast')
    assert.deepEqual(
      speedOffer('chatgpt', 'gpt-6-sol', catalog).options,
      [{ mode: 'fast', costMultiplier: 2 }, { mode: 'ultrafast' }],
      'no published Ultrafast price for gpt-6-sol'
    )
    assert.deepEqual(
      speedOffer('chatgpt', 'codex-auto-review', catalog).options,
      [{ mode: 'fast' }],
      'a model the pricing page does not list has no price'
    )
    assert.deepEqual(speedOffer('chatgpt', 'gpt-daybreak-blue-latest', catalog).options, [])
    assert.deepEqual(speedOffer('chatgpt', 'gpt-5.5', catalog).options, [], 'not in the catalog')
    assert.equal(parseChatGptCatalog({ data: [] }), undefined)
    assert.equal(parseChatGptCatalog('nope'), undefined)
  }
)

await check('speedOffer: Claude fast mode needs an Anthropic API key', () => {
  for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']) {
    assert.deepEqual(speedOffer('anthropic-api-key', id).options, [
      { mode: 'fast', costMultiplier: 2 }
    ])
  }
  assert.deepEqual(speedOffer('anthropic-api-key', 'claude-sonnet-5-5').options, [])
  assert.deepEqual(speedOffer('anthropic-subscription', 'claude-opus-5-5'), {
    options: [],
    unavailableReason: 'Claude fast mode needs an Anthropic API key'
  })
  assert.deepEqual(speedOffer('anthropic-subscription', 'claude-sonnet-5-5'), { options: [] })
  assert.deepEqual(speedOffer(undefined, 'gemini-2.5-pro'), { options: [] })
})

await check('effectiveMode / speedState: the best offered mode at or below the request', () => {
  const both = speedOffer('openai-api-key', 'gpt-6.1-sol').options
  const fast = speedOffer('openai-api-key', 'gpt-5.5').options
  assert.equal(effectiveMode('ultrafast', both), 'ultrafast')
  assert.equal(effectiveMode('ultrafast', fast), 'fast')
  assert.equal(effectiveMode('fast', []), 'standard')
  assert.equal(effectiveMode('standard', both), 'standard')
  const notice = { id: 7, text: 'Ultrafast mode turned off: Unsupported service_tier: ultrafast' }
  assert.deepEqual(
    speedState('fast', { options: [], unavailableReason: 'why' }, undefined, notice),
    { requested: 'fast', effective: 'standard', options: [], unavailableReason: 'why', notice }
  )
})

await check('savedMode: the latest valid speed entry on the branch', () => {
  const entry = (data: unknown) => ({ type: 'custom', customType: SPEED_ENTRY, data })
  assert.equal(savedMode([]), undefined)
  assert.equal(savedMode([entry({ mode: 'fast' }), entry({ mode: 'ultrafast' })]), 'ultrafast')
  assert.equal(
    savedMode([entry({ mode: 'fast' }), entry({ mode: 'warp' }), { type: 'message' }]),
    'fast'
  )
  assert.equal(
    savedMode([{ type: 'custom', customType: 'other', data: { mode: 'fast' } }]),
    undefined
  )
})

await check('withSpeed: OpenAI service tiers and Claude fast mode on the wire', () => {
  const body = { model: 'gpt-6.1-sol', input: [] }
  assert.deepEqual(withSpeed(body, 'openai-api-key', 'fast'), { ...body, service_tier: 'priority' })
  assert.deepEqual(withSpeed(body, 'chatgpt', 'ultrafast'), { ...body, service_tier: 'ultrafast' })
  assert.equal(withSpeed({ ...body, service_tier: 'priority' }, 'chatgpt', 'standard'), undefined)
  const claude = { model: 'claude-opus-5-5', betas: ['interleaved-thinking-2025-05-14'] }
  assert.deepEqual(withSpeed(claude, 'anthropic-api-key', 'fast'), {
    ...claude,
    speed: 'fast',
    betas: ['interleaved-thinking-2025-05-14', 'fast-mode-2026-02-01']
  })
  const twice = withSpeed(
    withSpeed({ model: 'claude-opus-5-5' }, 'anthropic-api-key', 'fast'),
    'anthropic-api-key',
    'fast'
  )
  assert.deepEqual(twice?.betas, ['fast-mode-2026-02-01'])
  assert.equal(withSpeed(claude, 'anthropic-subscription', 'fast'), undefined)
  assert.equal(isRequestFor(body, 'gpt-6.1-sol'), true)
  assert.equal(isRequestFor({ model: 'routed-model' }, 'gpt-6.1-sol'), false)
})

await check('reportedMode: what the provider confirmed', () => {
  const completed = (serviceTier: string) => ({
    type: 'response.completed',
    response: { service_tier: serviceTier }
  })
  assert.equal(reportedMode('openai-api-key', completed('priority')), 'fast')
  assert.equal(reportedMode('openai-api-key', completed('ultrafast')), 'ultrafast')
  assert.equal(reportedMode('openai-api-key', completed('default')), 'standard')
  assert.equal(reportedMode('openai-api-key', completed('auto')), undefined)
  assert.equal(reportedMode('openai-api-key', { type: 'response.output_text.delta' }), undefined)
  assert.equal(reportedMode('chatgpt', completed('default')), undefined, 'ChatGPT echo is unusable')
  const start = { type: 'message_start', message: { usage: { speed: 'fast' } } }
  assert.equal(reportedMode('anthropic-api-key', start), 'fast')
  const delta = { type: 'message_delta', usage: { speed: 'standard' } }
  assert.equal(reportedMode('anthropic-api-key', delta), 'standard')
})

/** Per-million-token rates, the shape of pi-ai's `Model.cost`. */
interface Rates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
const RATES: Rates = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 }
const FALLBACK_RATES: Rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 }
/** 1000 input and 100 output tokens at `RATES`; `FALLBACK_RATES` halve it. */
const STANDARD_COST = 0.003

/** Stands in for pi-ai's `calculateCost`, which the bridge injects: rates per million tokens. */
function calculateCost(model: { cost: Rates }, usage: SpeedUsage): void {
  const { input, output, cacheRead, cacheWrite } = model.cost
  usage.cost.input = (input * usage.input) / 1e6
  usage.cost.output = (output * usage.output) / 1e6
  usage.cost.cacheRead = (cacheRead * usage.cacheRead) / 1e6
  usage.cost.cacheWrite = (cacheWrite * usage.cacheWrite) / 1e6
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite
}

interface TestModel {
  id: string
  provider: string
  cost: Rates
  compat?: unknown
}
const pricedModel = (id: string, provider = 'openai', compat?: unknown): TestModel => ({
  id,
  provider,
  cost: RATES,
  ...(compat ? { compat } : {})
})
const SOL = pricedModel('gpt-6.1-sol')
const OPUS = pricedModel('claude-opus-5-5', 'anthropic')

await check('startSpeedRequest: the payload and the request followed until its response', () => {
  const body = { model: 'gpt-5.5', input: [] }
  const gpt55 = pricedModel('gpt-5.5')
  const fastOnly = speedOffer('openai-api-key', 'gpt-5.5').options
  assert.deepEqual(startSpeedRequest(body, gpt55, 'openai-api-key', 'ultrafast', fastOnly), {
    payload: { ...body, service_tier: 'priority' },
    request: { model: gpt55, route: 'openai-api-key', sent: 'fast', modified: true }
  })
  assert.deepEqual(startSpeedRequest(body, gpt55, 'openai-api-key', 'standard', fastOnly), {
    payload: undefined,
    request: { model: gpt55, route: 'openai-api-key', sent: 'standard', modified: false }
  })
  assert.equal(
    startSpeedRequest({ model: 'routed-model' }, gpt55, 'openai-api-key', 'fast', fastOnly),
    undefined,
    'a virtual model routes to another id'
  )
  assert.deepEqual(startSpeedRequest(body, gpt55, undefined, 'fast', [])?.request, {
    model: gpt55,
    route: undefined,
    sent: 'standard',
    modified: false
  })
})

/** The usage a provider package reported, with the `total` it priced (possibly multiplied). */
const usage = (input: number, output: number, total = 0): SpeedUsage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total }
})
const request = (
  route: SpeedRequest['route'],
  sent: SpeedRequest['sent'],
  reported?: SpeedRequest['reported'],
  model: TestModel = SOL
): SpeedRequest<TestModel> => ({
  model,
  route,
  sent,
  modified: sent !== 'standard',
  ...(reported ? { reported } : {})
})
const response = (
  model: string,
  stopReason = 'stop',
  extra: Partial<SpeedResponse<SpeedUsage>> = {}
) => ({
  model,
  stopReason,
  usage: usage(1000, 100, STANDARD_COST * 2),
  ...extra
})
const settle = (speedRequest: SpeedRequest<TestModel>, speedResponse: SpeedResponse<SpeedUsage>) =>
  settleSpeedRequest(speedRequest, speedResponse, calculateCost)

await check('settleSpeedRequest: the confirmed speed and the cost of a response', () => {
  const confirmed = settle(request('openai-api-key', 'fast', 'fast'), response('gpt-6.1-sol'))
  assert.deepEqual(confirmed.lastResponse, { mode: 'fast', confirmed: true })
  near(confirmed.cost?.total, STANDARD_COST * 2, 'recomputed, not doubled again')
  assert.equal(confirmed.refusal, undefined)

  const downgraded = settle(
    request('openai-api-key', 'ultrafast', 'standard'),
    response('gpt-6.1-sol')
  )
  assert.deepEqual(downgraded.lastResponse, { mode: 'standard', confirmed: true })
  near(downgraded.cost?.total, STANDARD_COST, 'billed at the echoed tier')

  const chatgpt = settle(request('chatgpt', 'ultrafast'), response('gpt-6.1-sol'))
  assert.deepEqual(chatgpt.lastResponse, { mode: 'ultrafast', confirmed: false })
  near(chatgpt.cost?.total, STANDARD_COST * 6, 'ChatGPT: billed at what was sent')

  const gpt55 = settle(
    request('openai-api-key', 'fast', undefined, pricedModel('gpt-5.5')),
    response('gpt-5.5')
  )
  near(gpt55.cost?.total, STANDARD_COST * 2.5, 'gpt-5.5 Fast')

  const gpt41 = settle(
    request('openai-api-key', 'fast', 'fast', pricedModel('gpt-4.1')),
    response('gpt-4.1')
  )
  near(gpt41.cost?.total, STANDARD_COST * 1.75, 'gpt-4.1 Fast')

  const standard = settle(
    request('openai-api-key', 'standard', 'standard'),
    response('gpt-6.1-sol')
  )
  assert.deepEqual(standard, { lastResponse: { mode: 'standard', confirmed: true } })

  const unpriced = settle(
    request('chatgpt', 'fast', undefined, pricedModel('codex-auto-review')),
    response('codex-auto-review')
  )
  assert.deepEqual(
    unpriced,
    { lastResponse: { mode: 'fast', confirmed: false } },
    'no published price: the Engine cost stays'
  )
})

await check('settleSpeedRequest: Claude is fast when reported, a fallback at its rates', () => {
  const fallbacks = {
    allowedFallbackModels: [
      { provider: 'anthropic', model: 'claude-opus-4-8', cost: FALLBACK_RATES }
    ]
  }
  const opus = pricedModel('claude-opus-5-5', 'anthropic', fallbacks)
  const fast = request('anthropic-api-key', 'fast', 'fast', opus)
  const unreported = request('anthropic-api-key', 'fast', undefined, opus)
  const fallbackAnswer = response('claude-opus-5-5', 'stop', { responseModel: 'claude-opus-4-8' })
  const datedAnswer = response('claude-opus-5-5', 'stop', {
    responseModel: 'claude-opus-5-5-20260201'
  })
  near(settle(fast, response('claude-opus-5-5')).cost?.total, STANDARD_COST * 2, 'usage.speed fast')
  near(
    settle(unreported, response('claude-opus-5-5')).cost?.total,
    STANDARD_COST,
    'no usage.speed: standard'
  )
  near(
    settle(fast, fallbackAnswer).cost?.total,
    STANDARD_COST,
    'a configured fallback answered: fast at its (half) rates'
  )
  near(
    settle(fast, datedAnswer).cost?.total,
    STANDARD_COST * 2,
    'another response id: the model rates, like pi-ai'
  )
})

await check('settleSpeedRequest: cut-off responses and refusals', () => {
  const aborted = settle(request('chatgpt', 'fast'), response('gpt-6.1-sol', 'aborted'))
  assert.equal(aborted.lastResponse, undefined)
  near(aborted.cost?.total, STANDARD_COST * 2, 'partial usage at the sent mode')
  const claudeError = settle(
    request('anthropic-api-key', 'fast', 'fast', OPUS),
    response('claude-opus-5-5', 'error', { errorMessage: '529 Overloaded' })
  )
  assert.deepEqual(Object.keys(claudeError), ['cost'])
  near(claudeError.cost?.total, STANDARD_COST * 2, 'partial usage at the reported mode')
  const empty = settle(request('chatgpt', 'fast'), {
    ...response('gpt-6.1-sol', 'aborted'),
    usage: usage(0, 0)
  })
  assert.deepEqual(empty, {}, 'nothing used, nothing to price')

  const refused = settle(request('openai-api-key', 'ultrafast'), {
    ...response('gpt-6.1-sol', 'error'),
    usage: usage(0, 0),
    errorMessage:
      'OpenAI API error (400): {"message":"Unsupported service_tier: ultrafast",' +
      '"type":"invalid_request_error","param":"service_tier","code":null}'
  })
  assert.deepEqual(refused, {
    refusal: 'Ultrafast mode turned off: Unsupported service_tier: ultrafast'
  })
  const rateLimited = settle(request('openai-api-key', 'fast'), {
    ...response('gpt-6.1-sol', 'error'),
    usage: usage(0, 0),
    errorMessage: '429 Rate limit'
  })
  assert.deepEqual(rateLimited, {})
  const standardError = settle(request('openai-api-key', 'standard'), {
    ...response('gpt-6.1-sol', 'error'),
    usage: usage(0, 0),
    errorMessage: '400 Unsupported service_tier: flex'
  })
  assert.deepEqual(standardError, {}, 'a standard request refuses nothing of ours')
})

await check('costMultiplier: the price of each mode', () => {
  assert.equal(costMultiplier('gpt-5.5', 'fast'), 2.5)
  assert.equal(costMultiplier('gpt-4.1', 'fast'), 1.75)
  assert.equal(costMultiplier('gpt-6.1-sol', 'ultrafast'), 6)
  assert.equal(costMultiplier('gpt-6-sol', 'ultrafast'), undefined, 'no published price')
  assert.equal(costMultiplier('codex-auto-review', 'fast'), undefined, 'not on the pricing page')
  assert.equal(costMultiplier('claude-opus-5-5', 'fast'), 2)
  assert.equal(costMultiplier('claude-opus-5-5', 'standard'), 1)
})

await check('speedRefusal: provider errors that refuse the faster mode', () => {
  assert.equal(
    speedRefusal('chatgpt', '400 Unsupported service_tier: fast'),
    'Unsupported service_tier: fast'
  )
  assert.equal(
    speedRefusal('chatgpt', 'Unsupported service_tier: ultrafast'),
    'Unsupported service_tier: ultrafast',
    'the Codex transport names no status'
  )
  const projectError =
    '400 {"error":{"message":"Invalid service_tier argument: not allowed for this project",' +
    '"param":"service_tier"}}'
  assert.equal(
    speedRefusal('openai-api-key', projectError),
    'Invalid service_tier argument: not allowed for this project'
  )
  const sharingError =
    'OpenAI API error (400): {"message":"This capability is not available for shared ' +
    'subscriptions.","type":"invalid_request_error","param":"service_tier",' +
    '"code":"subscription_sharing_unsupported_capability"}'
  assert.equal(
    speedRefusal('chatgpt', sharingError),
    'This capability is not available for shared subscriptions.'
  )
  const engineError =
    'OpenAI API error (400): {"message":"Unsupported service_tier: priority",' +
    '"type":"invalid_request_error","param":"service_tier","code":null}'
  assert.equal(speedRefusal('openai-api-key', engineError), 'Unsupported service_tier: priority')
  assert.equal(
    speedRefusal('openai-api-key', 'OpenAI API error (429): Rate limit for service_tier priority'),
    undefined,
    'a rate limit is retried'
  )
  assert.equal(speedRefusal('openai-api-key', '429 Rate limit reached'), undefined)

  const claudeError = (status: number, message: string) =>
    `${status} {"type":"error","error":{"type":"rate_limit_error","message":"${message}"}}`
  assert.equal(
    speedRefusal(
      'anthropic-api-key',
      claudeError(429, 'Usage credits are required for fast mode.')
    ),
    'Usage credits are required for fast mode.'
  )
  assert.equal(
    speedRefusal('anthropic-api-key', claudeError(429, 'Fast mode is not enabled for this org.')),
    'Fast mode is not enabled for this org.'
  )
  assert.equal(
    speedRefusal('anthropic-api-key', claudeError(429, 'Rate limit exceeded for fast mode.')),
    undefined,
    'a plain fast-pool rate limit is retried'
  )
  assert.equal(
    speedRefusal(
      'anthropic-api-key',
      "400 'claude-sonnet-5-5' does not support the `speed` parameter"
    ),
    "'claude-sonnet-5-5' does not support the `speed` parameter"
  )
  assert.equal(
    speedRefusal('anthropic-api-key', '400 messages: text content blocks must be non-empty'),
    undefined
  )
  assert.equal(speedRefusal('anthropic-api-key', '529 Overloaded'), undefined)
  assert.equal(speedRefusal('chatgpt', undefined), undefined)
})

await check('chatGptCatalogRequest: catalog URL and account headers', () => {
  const claims = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })
  ).toString('base64url')
  const token = `header.${claims}.signature`
  const codex = chatGptCatalogRequest('openai-codex', 'https://chatgpt.com/backend-api/', token)
  assert.deepEqual(codex, {
    url: 'https://chatgpt.com/backend-api/codex/models?client_version=0.162.0',
    headers: {
      Authorization: `Bearer ${token}`,
      originator: 'codex_cli_rs',
      'chatgpt-account-id': 'acct-1'
    }
  })
  const plain = chatGptCatalogRequest('openai', 'https://api.openai.com/v1', 'not-a-jwt')
  assert.equal(plain.url, 'https://api.openai.com/v1/models')
  assert.equal(plain.headers['chatgpt-account-id'], undefined)
})
