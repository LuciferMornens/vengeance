// OrcaRouter on both engines: native API-key login, the one catalog model, the documented reasoning
// ladder, tools, images, cache accounting and the request shape the API accepts. Local fake
// providers by default, with the built-in entry kept authoritative by a URL-only override.
//
// Paid live runs are opt-in: VENGEANCE_LIVE_ORCAROUTER_QA=1 and ORCAROUTER_API_KEY. They use tiny
// prompts and bounded output against the real API, in temporary accounts.
//
//   npm run build && node scripts/qa/auth/orcarouter.qa.mjs
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

const PROVIDER = 'orcarouter'
const MODEL_ID = 'orca/orcacyber-k3.1-pro'
const MODEL_NAME = 'Kimi K3.1 Pro Abliterated / Uncensored'
const ENVIRONMENT_VARIABLE = 'ORCAROUTER_API_KEY'
const LIVE = process.env.VENGEANCE_LIVE_ORCAROUTER_QA === '1'
const API_KEY = LIVE ? process.env[ENVIRONMENT_VARIABLE] : 'qa-orcarouter-key'
const SUITE = LIVE ? 'auth-orcarouter-live' : 'auth-orcarouter'
const LIVE_OUTPUT_LIMIT = 1024
const LIVE_TURN_TIMEOUT_MS = 180_000
const LIVE_OFF_TURN_TIMEOUT_MS = 45_000
const FAKE_TURN_TIMEOUT_MS = 60_000
const ENGINE_READY_TIMEOUT_MS = 60_000
const LEVELS = ['off', 'low', 'high', 'max']
const LEVEL_LABELS = ['Off', 'Low', 'High', 'Max']
const WIRE_EFFORTS = { off: 'none', low: 'low', high: 'high', max: 'max' }
const SAVED_LEVELS = { minimal: 'low', medium: 'high', xhigh: 'max' }
const MODEL_LIMITS = { contextWindow: 1_048_576, maxTokens: 943_718 }
const MODEL_COST = { input: 4, output: 20, cacheRead: 0.35, cacheWrite: 4 }
// Live figures from a growing prompt: 3905 prompt tokens were 65 plain + 2560 read + 1280 written.
const CACHE_USAGE = { input: 65, output: 11, cacheRead: 2560, cacheWrite: 1280 }
const TOKENS_PER_MILLION = 1_000_000
const COST_TOLERANCE = 1e-9
const IMAGE_SIZE = 16
const IMAGE = makePng(IMAGE_SIZE, IMAGE_SIZE, [200, 40, 40])
const TOOL_MARKER = 'ORCAROUTER_TOOL_OK'
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

if (!API_KEY) throw new Error(`Live OrcaRouter QA requires ${ENVIRONMENT_VARIABLE}`)

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

/** URL-only overrides keep the built-in entry authoritative; live runs only bound its output. */
async function routeProvider(directory, baseUrl) {
  const path = join(directory, 'models.json')
  const configured = JSON.parse(await readFile(path, 'utf8'))
  configured.providers[PROVIDER] = LIVE
    ? { modelOverrides: { [MODEL_ID]: { maxTokens: LIVE_OUTPUT_LIMIT } } }
    : { baseUrl }
  await writeFile(path, `${JSON.stringify(configured, null, 2)}\n`)
}

function assistantMessages(state) {
  return state.entries
    .map((entry) => entry.message)
    .filter((message) => message.role === 'assistant')
}

function assistantText(state) {
  return assistantMessages(state)
    .flatMap((message) => message.content)
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('')
}

/** What every request must look like: each field was probed against the live API. */
function assertRequestShape(request) {
  const { body, headers } = request
  assert.equal(body.model, MODEL_ID)
  assert.equal(headers.authorization, `Bearer ${API_KEY}`)
  assert.ok(body.max_tokens > 0, 'the output limit travels as max_tokens')
  assert.equal(body.max_completion_tokens, undefined)
  assert.equal(body.store, undefined)
  assert.equal(body.prompt_cache_retention, undefined)
  assert.ok(
    body.messages.every((message) => message.role !== 'developer'),
    'the API answers 400 to the developer role'
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
  const state = await app.agentState()
  return {
    state,
    requests: server.requests.slice(from).filter((request) => request.method === 'POST'),
    messages: assistantMessages(state).slice(seen)
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
      `${prefix} one model with its live limits, prices and documented ladder`,
      async () => {
        const catalog = await engineSettings(app, engine.id, 'settings:catalog')
        const provider = catalog.providers.find((entry) => entry.id === PROVIDER)
        assert.ok(provider, 'the provider row exists before any key')
        assert.equal(provider.status.configured, false)
        assert.deepEqual(provider.envVars, [ENVIRONMENT_VARIABLE])
        const models = catalog.models.filter((model) => model.provider === PROVIDER)
        assert.deepEqual(
          models.map((model) => model.id),
          [MODEL_ID]
        )
        const [model] = models
        assert.equal(model.name, MODEL_NAME)
        assert.deepEqual(model.thinkingLevels, LEVELS)
        assert.deepEqual(model.input, ['text', 'image'])
        assert.equal(model.contextWindow, MODEL_LIMITS.contextWindow)
        assert.ok(model.maxTokens === (LIVE ? LIVE_OUTPUT_LIMIT : MODEL_LIMITS.maxTokens))
        assert.deepEqual(model.cost, MODEL_COST)
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
        assert.equal(auth[PROVIDER]?.key, API_KEY, 'the key is saved in the temporary account only')
        const catalog = await engineSettings(app, engine.id, 'settings:catalog')
        const provider = catalog.providers.find((entry) => entry.id === PROVIDER)
        assert.equal(provider.name, 'OrcaRouter')
        assert.ok(!JSON.stringify(catalog).includes(API_KEY), 'catalog masks the key')
      }
    )

    await step(`${prefix} a new conversation starts on the model and lists it`, async () => {
      ;({ agentId } = await app.openWorkspace({
        cwd: workspace,
        args: { engine: engine.id, provider: PROVIDER, model: MODEL_ID }
      }))
      await until(async () => (await app.agentState(agentId))?.status === 'ready', {
        label: 'engine ready',
        timeoutMs: ENGINE_READY_TIMEOUT_MS
      })
      await until(async () => (await app.agentState(agentId))?.model?.id === MODEL_ID, {
        label: 'OrcaRouter model selected',
        timeoutMs: ENGINE_READY_TIMEOUT_MS
      })
      await app.page
        .getByRole('button', { name: /^Model:/ })
        .filter({ visible: true })
        .click()
      await app.page.getByPlaceholder('Search models…').fill('orcacyber')
      await app.page.locator(`[cmdk-item][data-value="${PROVIDER}/${MODEL_ID}"]`).waitFor()
      await app.screenshot(`orcarouter-${engine.id}-picker`)
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
      await app.screenshot(`orcarouter-${engine.id}-efforts`)
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
            const text = assistantText({ entries: messages.map((message) => ({ message })) })
            assert.match(text.toLowerCase(), /ok/)
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
        const { state, requests } = await sendTurn(app, server, TOOL_PROMPT, [
          turn.toolCall(engine.tool, engine.toolArguments, { thinking: 'Read the proof.' }),
          turn.text(TOOL_MARKER)
        ])
        assert.ok(
          assistantText(state).includes(TOOL_MARKER),
          'the model returned the file contents'
        )
        if (LIVE) return
        assert.equal(requests.length, 2)
        requests.forEach(assertRequestShape)
        const continuation = inspectRequest(requests[1])
        assert.ok(
          continuation.toolResults[0].text.includes(TOOL_MARKER),
          continuation.toolResults[0].text
        )
        const replayed = requests[1].body.messages.findLast((message) => message.tool_calls)
        assert.equal(replayed.reasoning_content, 'Read the proof.')
      }
    )

    await checks.check(`${prefix} a pasted image reaches the model`, async () => {
      await pasteImage(app)
      const { requests, messages } = await sendTurn(app, server, 'What colour? One word.', [
        turn.text('Red')
      ])
      assert.equal(messages.at(-1)?.stopReason, 'stop', messages.at(-1)?.errorMessage)
      if (LIVE) {
        const text = assistantText({ entries: messages.map((message) => ({ message })) })
        assert.match(text, /red/i)
        return
      }
      assert.equal(inspectRequest(requests[0]).imageCount, 1)
    })

    if (LIVE) continue

    await checks.check(`${prefix} cache reads and writes are counted apart`, async () => {
      const { messages } = await sendTurn(app, server, REPLY_PROMPT, [
        turn.text('ok', { usage: CACHE_USAGE })
      ])
      const { usage } = messages.at(-1)
      assert.equal(usage.input, CACHE_USAGE.input)
      assert.equal(usage.cacheRead, CACHE_USAGE.cacheRead)
      assert.equal(usage.cacheWrite, CACHE_USAGE.cacheWrite)
      const expected =
        (CACHE_USAGE.input * MODEL_COST.input +
          CACHE_USAGE.output * MODEL_COST.output +
          CACHE_USAGE.cacheRead * MODEL_COST.cacheRead +
          CACHE_USAGE.cacheWrite * MODEL_COST.cacheWrite) /
        TOKENS_PER_MILLION
      assert.ok(Math.abs(usage.cost.total - expected) < COST_TOLERANCE, `cost ${usage.cost.total}`)
    })

    for (const [saved, offered] of Object.entries(SAVED_LEVELS)) {
      await checks.check(`${prefix} a saved ${saved} level moves up to ${offered}`, async () => {
        await app.rpc({ type: 'set_thinking_level', level: saved }, agentId)
        await until(
          async () => (await app.rpc({ type: 'get_state' }, agentId)).thinkingLevel === offered,
          {
            label: `${saved} clamps to ${offered}`
          }
        )
      })
    }

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
    outDir: reportShotsDir('orcarouter')
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
