// SilkCompute on both engines: native API-key login, the five abliterated catalog models, the documented
// reasoning ladder with Off, tools, images on the vision models, text-only GLM-5.3, cache accounting and
// the request shape the API accepts. Local fake providers by default, with the built-in entries kept
// authoritative by a URL-only override.
//
// Paid live runs are opt-in: VENGEANCE_LIVE_SILKCOMPUTE_QA=1 and SILK_API_KEY. They use tiny prompts and
// bounded output against the real API, in temporary accounts.
//
//   npm run build && node scripts/qa/auth/silkcompute.qa.mjs
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { makePng, pickThinkingLevel, until } from '../chat/helpers.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import {
  createEngineFixture,
  engineSettings,
  storeApiKey
} from '../engines/integration-fixture.mjs'

const PROVIDER = 'silkcompute'
const PROVIDER_NAME = 'SilkCompute'
const ENVIRONMENT_VARIABLE = 'SILK_API_KEY'
const LIVE = process.env.VENGEANCE_LIVE_SILKCOMPUTE_QA === '1'
const API_KEY = LIVE ? process.env[ENVIRONMENT_VARIABLE] : 'qa-silkcompute-key'
const SUITE = LIVE ? 'auth-silkcompute-live' : 'auth-silkcompute'
const LIVE_OUTPUT_LIMIT = 2048
const LIVE_TURN_TIMEOUT_MS = 180_000
const LIVE_OFF_TURN_TIMEOUT_MS = 45_000
const FAKE_TURN_TIMEOUT_MS = 60_000
const ENGINE_READY_TIMEOUT_MS = 60_000
const CONTEXT_WINDOW = 1_048_576
const VISION = ['text', 'image']
/** GET /v1/models limits and silkcompute.com/models prices; writes cost the input price. */
const MODELS = [
  {
    id: 'kimi-k3.1-pro-uncensored',
    name: 'Kimi K3.1 Pro Uncensored',
    input: VISION,
    maxTokens: 131_072,
    cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 }
  },
  {
    id: 'deepseek-v4.1-flash-1017-uncensored',
    name: 'DeepSeek V4.1 Flash 1017 Uncensored',
    input: VISION,
    maxTokens: 131_072,
    cost: { input: 0.26, output: 0.9, cacheRead: 0.06, cacheWrite: 0.26 }
  },
  {
    id: 'glm-5.3-uncensored',
    name: 'GLM-5.3 Uncensored',
    input: ['text'],
    maxTokens: 131_072,
    cost: { input: 2, output: 4, cacheRead: 0.3, cacheWrite: 2 }
  },
  {
    id: 'glm-5.3-flash-uncensored',
    name: 'GLM-5.3 Flash Uncensored',
    input: VISION,
    maxTokens: 131_072,
    cost: { input: 0.24, output: 1, cacheRead: 0.06, cacheWrite: 0.24 }
  },
  {
    id: 'hy4-uncensored',
    name: 'Hy4 Uncensored',
    input: VISION,
    maxTokens: 65_536,
    cost: { input: 1.6, output: 3.2, cacheRead: 0.3, cacheWrite: 1.6 }
  }
]
const [DEFAULT_MODEL] = MODELS
const TEXT_MODEL = MODELS.find((model) => model.id === 'glm-5.3-uncensored')
const LEVELS = ['off', 'low', 'high', 'max']
const LEVEL_LABELS = ['Off', 'Low', 'High', 'Max']
const WIRE_EFFORTS = { off: 'none', low: 'low', high: 'high', max: 'max' }
const SAVED_LEVELS = { minimal: 'low', medium: 'high', xhigh: 'max' }
// Live figures (GLM-5.3 Flash): 2439 prompt tokens were 135 plain + 2304 cached, for 3 output tokens.
// No writes are reported.
const CACHE_USAGE = { input: 135, output: 3, cacheRead: 2304, cacheWrite: 0 }
const TOKENS_PER_MILLION = 1_000_000
const COST_TOLERANCE = 1e-9
const IMAGE_SIZE = 16
const IMAGE = makePng(IMAGE_SIZE, IMAGE_SIZE, [200, 40, 40])
const TOOL_MARKER = 'SILKCOMPUTE_TOOL_OK'
const PROOF_FILE = 'proof.txt'
const REPLY_PROMPT = 'Reply with just: ok'
const TOOL_PROMPT = `Read ${PROOF_FILE} with a tool, then reply with its contents.`
const ENGINES = [
  { id: 'pi', label: 'Engine', tool: 'read', toolArguments: { path: PROOF_FILE } },
  {
    id: 'prime',
    label: 'Engine 2',
    tool: 'python_repl',
    toolArguments: { code: `print(open('${PROOF_FILE}').read())` }
  }
]

if (!API_KEY) throw new Error(`Live SilkCompute QA requires ${ENVIRONMENT_VARIABLE}`)

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

/** URL-only overrides keep the built-in entries authoritative; live runs only bound their output. */
async function routeProvider(directory, baseUrl) {
  const path = join(directory, 'models.json')
  const configured = JSON.parse(await readFile(path, 'utf8'))
  configured.providers[PROVIDER] = LIVE
    ? {
        modelOverrides: Object.fromEntries(
          MODELS.map((model) => [model.id, { maxTokens: LIVE_OUTPUT_LIMIT }])
        )
      }
    : { baseUrl }
  await writeFile(path, `${JSON.stringify(configured, null, 2)}\n`)
}

function assistantMessages(state) {
  return state.entries
    .map((entry) => entry.message)
    .filter((message) => message.role === 'assistant')
}

function assistantText(messages) {
  return messages
    .flatMap((message) => message.content)
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('')
}

/** What every request must look like: each field was probed against the live API. */
function assertRequestShape(request, modelId = DEFAULT_MODEL.id) {
  const { body, headers } = request
  assert.equal(body.model, modelId)
  assert.equal(headers.authorization, `Bearer ${API_KEY}`)
  assert.ok(body.max_tokens > 0, 'the output limit travels as max_tokens')
  assert.equal(body.max_completion_tokens, undefined)
  assert.equal(body.store, undefined)
  assert.equal(body.prompt_cache_retention, undefined)
  assert.ok(
    body.messages.every((message) => message.role !== 'developer'),
    'instructions travel in the system role'
  )
  assert.ok(
    (body.tools ?? []).every((tool) => !('strict' in tool.function)),
    'tools stay without strict mode'
  )
}

async function pasteImage(app) {
  await app.page.evaluate(
    ({ base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([bytes], 'red.png', { type: 'image/png' }))
      document
        .querySelector('textarea[aria-label="Message"]')
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })
        )
    },
    { base64: IMAGE.toString('base64') }
  )
  await until(async () => (await app.page.locator('[data-composer] img').count()) === 1, {
    label: 'pasted image prepared'
  })
}

/** With reasoning off the model can keep calling tools, so a live Off turn stops at a bound. */
async function settleLiveOffTurn(app) {
  try {
    await app.waitForSettle({ timeoutMs: LIVE_OFF_TURN_TIMEOUT_MS })
  } catch {
    await app.rpc({ type: 'abort' })
    await app.waitForSettle({ timeoutMs: LIVE_OFF_TURN_TIMEOUT_MS })
  }
}

/** Send through the composer; resolves with the turn's model requests and new assistant messages. */
async function sendTurn(app, server, prompt, answers, settle) {
  const from = server.requests.length
  const seen = assistantMessages(await app.agentState()).length
  if (!LIVE) server.queue(...answers)
  await app.send(prompt)
  await (settle?.(app) ??
    app.waitForSettle({ timeoutMs: LIVE ? LIVE_TURN_TIMEOUT_MS : FAKE_TURN_TIMEOUT_MS }))
  return {
    requests: server.requests.slice(from).filter((request) => request.method === 'POST'),
    messages: assistantMessages(await app.agentState()).slice(seen)
  }
}

/** Open a conversation on one SilkCompute model and wait until the engine has selected it. */
async function openOnModel(app, engine, workspace, model) {
  const { agentId } = await app.openWorkspace({
    cwd: workspace,
    args: { engine: engine.id, provider: PROVIDER, model: model.id }
  })
  await until(async () => (await app.agentState(agentId))?.status === 'ready', {
    label: 'engine ready',
    timeoutMs: ENGINE_READY_TIMEOUT_MS
  })
  await until(async () => (await app.agentState(agentId))?.model?.id === model.id, {
    label: `${model.name} selected`,
    timeoutMs: ENGINE_READY_TIMEOUT_MS
  })
  return agentId
}

/** Exact usage figures and saved-level moves, which only a fake provider can pin down. */
async function accountingChecks({ app, server, checks, prefix, agentId }) {
  await checks.check(`${prefix} cached input is counted at the cache price`, async () => {
    const { messages } = await sendTurn(app, server, REPLY_PROMPT, [
      turn.text('ok', { usage: CACHE_USAGE })
    ])
    const { usage } = messages.at(-1)
    assert.equal(usage.input, CACHE_USAGE.input)
    assert.equal(usage.cacheRead, CACHE_USAGE.cacheRead)
    assert.equal(usage.cacheWrite, CACHE_USAGE.cacheWrite)
    const { cost } = DEFAULT_MODEL
    const expected =
      (CACHE_USAGE.input * cost.input +
        CACHE_USAGE.output * cost.output +
        CACHE_USAGE.cacheRead * cost.cacheRead) /
      TOKENS_PER_MILLION
    assert.ok(Math.abs(usage.cost.total - expected) < COST_TOLERANCE, `cost ${usage.cost.total}`)
  })

  for (const [saved, offered] of Object.entries(SAVED_LEVELS)) {
    await checks.check(`${prefix} a saved ${saved} level moves up to ${offered}`, async () => {
      await app.rpc({ type: 'set_thinking_level', level: saved }, agentId)
      await until(
        async () => (await app.rpc({ type: 'get_state' }, agentId)).thinkingLevel === offered,
        { label: `${saved} clamps to ${offered}` }
      )
    })
  }
}

async function suiteBody(fixture, app, checks) {
  for (const engine of ENGINES) {
    const server = engine.id === 'pi' ? fixture.piServer : fixture.primeServer
    const prefix = `${engine.label}:`
    const workspace = await fixture.root.folder(`workspace-${engine.id}`, {
      [PROOF_FILE]: `${TOOL_MARKER}\n`
    })
    let agentId

    await step(`${prefix} open a conversation so the native catalog answers`, async () => {
      ;({ agentId } = await app.openWorkspace({ cwd: workspace, args: { engine: engine.id } }))
      await until(async () => (await app.agentState(agentId))?.status === 'ready', {
        label: 'engine ready',
        timeoutMs: ENGINE_READY_TIMEOUT_MS
      })
    })

    await checks.check(
      `${prefix} five models with their live limits, prices, inputs and documented ladder`,
      async () => {
        const catalog = await engineSettings(app, engine.id, 'settings:catalog')
        const provider = catalog.providers.find((entry) => entry.id === PROVIDER)
        assert.ok(provider, 'the provider row exists before any key')
        assert.equal(provider.status.configured, false)
        assert.deepEqual(provider.envVars, [ENVIRONMENT_VARIABLE])
        const models = catalog.models.filter((model) => model.provider === PROVIDER)
        assert.deepEqual(
          models.map((model) => model.id).sort(),
          MODELS.map((model) => model.id).sort()
        )
        for (const expected of MODELS) {
          const model = models.find((entry) => entry.id === expected.id)
          assert.equal(model.name, expected.name)
          assert.deepEqual(model.thinkingLevels, LEVELS, expected.id)
          assert.deepEqual(model.input, expected.input, expected.id)
          assert.equal(model.contextWindow, CONTEXT_WINDOW)
          assert.equal(model.maxTokens, LIVE ? LIVE_OUTPUT_LIMIT : expected.maxTokens, expected.id)
          assert.deepEqual(model.cost, expected.cost, expected.id)
        }
      }
    )

    await step(`${prefix} save the key through native login`, async () => {
      await storeApiKey(app, engine.id, PROVIDER, API_KEY)
    })

    await checks.check(
      `${prefix} the provider connects and the catalog masks the key`,
      async () => {
        const directory = engine.id === 'pi' ? fixture.piDirectory.dir : fixture.primeDirectory
        const auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'))
        // assert.ok: a failed comparison must not print the key.
        assert.ok(auth[PROVIDER]?.key === API_KEY, 'the key is saved in the temporary account only')
        const catalog = await engineSettings(app, engine.id, 'settings:catalog')
        const provider = catalog.providers.find((entry) => entry.id === PROVIDER)
        assert.equal(provider.name, PROVIDER_NAME)
        assert.ok(!JSON.stringify(catalog).includes(API_KEY), 'catalog masks the key')
      }
    )

    await step(`${prefix} a new conversation starts on Kimi K3.1 Pro and lists it`, async () => {
      agentId = await openOnModel(app, engine, workspace, DEFAULT_MODEL)
      await app.page
        .getByRole('button', { name: /^Model:/ })
        .filter({ visible: true })
        .click()
      await app.page.getByPlaceholder('Search models…').fill('uncensored')
      for (const model of MODELS) {
        await app.page.locator(`[cmdk-item][data-value="${PROVIDER}/${model.id}"]`).waitFor()
      }
      await app.screenshot(`silkcompute-${engine.id}-picker`)
      await app.page.keyboard.press('Escape')
    })

    await checks.check(`${prefix} the composer offers exactly Off, Low, High and Max`, async () => {
      await app.page.getByRole('button', { name: /^Thinking level:/ }).click()
      const choices = app.page.getByRole('menuitemradio')
      await choices.first().waitFor()
      assert.equal(await choices.count(), LEVEL_LABELS.length)
      for (const label of LEVEL_LABELS) {
        await choices.getByText(label, { exact: true }).waitFor()
      }
      await app.screenshot(`silkcompute-${engine.id}-efforts`)
      await app.page.keyboard.press('Escape')
    })

    for (const level of LEVELS) {
      await checks.check(
        `${prefix} ${level} reaches the provider with its wire value`,
        async () => {
          await pickThinkingLevel(app, level)
          const liveOff = LIVE && level === 'off'
          const { requests, messages } = await sendTurn(
            app,
            server,
            REPLY_PROMPT,
            [turn.text('ok')],
            liveOff ? settleLiveOffTurn : undefined
          )
          if (liveOff) {
            assert.notEqual(messages[0]?.stopReason, 'error', messages[0]?.errorMessage)
            return
          }
          assert.equal(messages.at(-1)?.stopReason, 'stop', messages.at(-1)?.errorMessage)
          if (LIVE) {
            assert.match(assistantText(messages).toLowerCase(), /ok/)
            return
          }
          assert.equal(requests.length, 1)
          assertRequestShape(requests[0])
          assert.equal(requests[0].body.reasoning_effort, WIRE_EFFORTS[level])
        }
      )
    }

    await checks.check(
      `${prefix} tool continuation replays reasoning with the tool result`,
      async () => {
        await pickThinkingLevel(app, 'high')
        const { requests, messages } = await sendTurn(app, server, TOOL_PROMPT, [
          turn.toolCall(engine.tool, engine.toolArguments, { thinking: 'Read the proof.' }),
          turn.text(TOOL_MARKER)
        ])
        assert.ok(
          assistantText(messages).includes(TOOL_MARKER),
          'the model returned the file contents'
        )
        if (LIVE) return
        assert.equal(requests.length, 2)
        requests.forEach((request) => assertRequestShape(request))
        const continuation = inspectRequest(requests[1])
        assert.ok(
          continuation.toolResults[0].text.includes(TOOL_MARKER),
          continuation.toolResults[0].text
        )
        const replayed = requests[1].body.messages.findLast((message) => message.tool_calls)
        assert.equal(replayed.reasoning_content, 'Read the proof.')
      }
    )

    await checks.check(`${prefix} a pasted image reaches Kimi K3.1 Pro`, async () => {
      await pasteImage(app)
      const { requests, messages } = await sendTurn(app, server, 'What colour? One word.', [
        turn.text('Red')
      ])
      assert.equal(messages.at(-1)?.stopReason, 'stop', messages.at(-1)?.errorMessage)
      if (LIVE) {
        assert.match(assistantText(messages), /red/i)
        return
      }
      assert.equal(inspectRequest(requests[0]).imageCount, 1)
    })

    if (!LIVE) await accountingChecks({ app, server, checks, prefix, agentId })

    // The Engine sends an image turn on a text-only model without the image. Engine 2 refuses it unless
    // its `imageModel` setting routes the turn to another model (scripts/qa/engines/image-refusal.qa.mjs).
    await step(`${prefix} a new conversation starts on text-only GLM-5.3`, async () => {
      agentId = await openOnModel(app, engine, workspace, TEXT_MODEL)
    })
    if (engine.id === 'pi')
      await checks.check(
        `${prefix} a pasted image is flagged on GLM-5.3 and stays out of the request`,
        async () => {
          await pasteImage(app)
          await app.page
            .getByText(`${TEXT_MODEL.name} can’t read images. They will be ignored.`)
            .waitFor()
          const { requests, messages } = await sendTurn(app, server, REPLY_PROMPT, [
            turn.text('ok')
          ])
          assert.equal(messages.at(-1)?.stopReason, 'stop', messages.at(-1)?.errorMessage)
          if (LIVE) return
          assertRequestShape(requests[0], TEXT_MODEL.id)
          assert.equal(inspectRequest(requests[0]).imageCount, 0)
        }
      )
    else
      await checks.check(
        `${prefix} a pasted image on GLM-5.3 is refused with its reason and reaches no provider`,
        async () => {
          await pasteImage(app)
          await app.page
            .getByText(
              `${TEXT_MODEL.name} can’t read images, so Engine 2 will refuse this message.`
            )
            .waitFor()
          const { requests, messages } = await sendTurn(app, server, REPLY_PROMPT, [])
          assert.equal(messages.length, 0, 'no response follows the refused message')
          assert.equal(requests.length, 0, 'a refused turn reaches no provider')
          await app.page
            .getByText(`${TEXT_MODEL.name} can’t read images`, { exact: true })
            .waitFor()
          await app.screenshot(`silkcompute-${engine.id}-image-refused`)
        }
      )

    await checks.check(`${prefix} no unexpected app errors`, async () => app.assertNoErrors())
  }
}

console.log(`▶ ${SUITE}${LIVE ? ' (paid live API, temporary accounts)' : ' (fake providers)'}`)
const fixture = await createEngineFixture()
let app = null
let failure = null
const checks = softSteps(step, { app: () => app, name: SUITE })

try {
  await routeProvider(fixture.piDirectory.dir, fixture.piServer.openaiBaseUrl)
  await routeProvider(fixture.primeDirectory, fixture.primeServer.openaiBaseUrl)
  app = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: { ...fixture.environment, [ENVIRONMENT_VARIABLE]: undefined },
    exe: process.env.QA_PACKAGED_EXE,
    outDir: reportShotsDir('silkcompute')
  })
  await suiteBody(fixture, app, checks)
  checks.finish()
} catch (error) {
  failure = error
  await app?.screenshot(`${SUITE}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await app
    ?.close({ beforeCleanup: fixture.stopNativeDaemon })
    .catch((error) => (failure ??= error))
  await fixture.cleanup().catch((error) => (failure ??= error))
}

if (failure) {
  console.error(`  ✗ ${failure.stack ?? failure}`)
  console.error(`✗ ${SUITE} failed`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE} passed`)
}
