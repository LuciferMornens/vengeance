import assert from 'node:assert/strict'
import { makePng } from '../chat/helpers.mjs'
import { FAKE_API_KEY } from '../lib/agent-dir.mjs'
import { reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  openAnotherWorkspace,
  openSettings,
  providerRow,
  readTempAuth,
  routeProviderToFake,
  sendVisible,
  settleVisible,
  waitUntil
} from './helpers.mjs'

const PROVIDER = 'abliteration'
const MODEL_IDS = ['abliterated-model', 'abliterated-model-large-v2', 'abliterated-model-large']
const LIVE = process.env.VENGEANCE_LIVE_ABLITERATION_QA === '1'
const API_KEY = LIVE ? process.env.ABLIT_KEY : FAKE_API_KEY
const LIVE_OUTPUT_LIMIT = 1024
const TOOL_MARKER = 'ABLITERATION_TOOL_OK'
const PROOF_FILE = 'proof.txt'
const PROMPT = 'Read proof.txt with the read tool, then reply with its contents.'
const IMAGE_SIZE = 16
const IMAGE = {
  type: 'image',
  mimeType: 'image/png',
  data: makePng(IMAGE_SIZE, IMAGE_SIZE).toString('base64')
}

if (!API_KEY) throw new Error('Live Abliteration QA requires ABLIT_KEY')

function assistantText(state) {
  return state.entries
    .filter((entry) => entry.message.role === 'assistant')
    .flatMap((entry) => entry.message.content)
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('')
}

async function openModel(app, modelId) {
  const cwd = await app.createWorkspace({ [PROOF_FILE]: TOOL_MARKER })
  await app.test('openWorkspace', cwd, { model: `${PROVIDER}/${modelId}` })
  await waitUntil(
    async () => (await app.page.getByRole('textbox', { name: 'Message' }).count()) === 1,
    { label: 'one active session pane' }
  )
}

await runSuite(
  LIVE ? 'auth-abliteration-live' : 'auth-abliteration',
  async ({ app, agentDir, server, step }) => {
    const page = app.page

    await step('isolate provider requests and bound live output', async () => {
      if (LIVE) {
        const config = await agentDir.readJson('models.json')
        config.providers[PROVIDER] = {
          modelOverrides: Object.fromEntries(
            MODEL_IDS.map((modelId) => [modelId, { maxTokens: LIVE_OUTPUT_LIMIT }])
          )
        }
        await agentDir.writeText('models.json', config)
      } else {
        await routeProviderToFake(agentDir, server, PROVIDER)
      }
      await app.openWorkspace()
      const catalog = await app.invoke('settings:catalog')
      const provider = catalog.providers.find((entry) => entry.id === PROVIDER)
      assert.equal(provider.status.configured, false)
      assert.deepEqual(catalog.envVars?.[PROVIDER] ?? provider.envVars, ['ABLIT_KEY'])
      const models = catalog.models.filter((model) => model.provider === PROVIDER)
      assert.deepEqual(models.map((model) => model.id).sort(), [...MODEL_IDS].sort())
      assert.deepEqual(models.find((model) => model.id === MODEL_IDS[1]).thinkingLevels, [
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max'
      ])
    })

    await step('connect through native API-key login and mask catalog credentials', async () => {
      await openSettings(app, 'providers', 'Providers & accounts')
      const showAll = page.getByRole('button', { name: /^Show all \d+ providers$/ })
      if (await showAll.count()) await showAll.click()
      const row = providerRow(page, PROVIDER)
      await row.getByRole('button', { name: 'Add key', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Abliteration API key', exact: true })
      await dialog.locator('input[type="password"]').fill(API_KEY)
      await dialog.getByRole('button', { name: 'Save key' }).click()
      await dialog.getByText('Connected', { exact: true }).waitFor()
      await dialog.waitFor({ state: 'detached' })
      const auth = await readTempAuth(agentDir)
      assert.ok(auth[PROVIDER]?.key === API_KEY, 'native auth saved only in the temp account')
      const catalog = await app.invoke('settings:catalog')
      assert.equal(catalog.providers.find((entry) => entry.id === PROVIDER).availableCount, 3)
      assert.ok(!JSON.stringify(catalog).includes(API_KEY), 'catalog masks the key')
      assert.ok(!(await page.locator('body').innerText()).includes(API_KEY), 'UI masks the key')
      await row.scrollIntoViewIfNeeded()
      await app.screenshot('abliteration-01-connected')
      await app.test('closeSettings')
    })

    await step(
      'all three models appear in a new native session and the composer picker',
      async () => {
        await openModel(app, MODEL_IDS[0])
        const { models } = await app.rpc({ type: 'get_available_models' })
        assert.deepEqual(
          models
            .filter((model) => model.provider === PROVIDER)
            .map((model) => model.id)
            .sort(),
          [...MODEL_IDS].sort()
        )
        await page
          .getByRole('button', { name: /^Model: / })
          .filter({ visible: true })
          .click()
        await page.getByPlaceholder('Search models…').fill('abliterated')
        for (const modelId of MODEL_IDS) {
          await page.locator(`[cmdk-item][data-value="${PROVIDER}/${modelId}"]`).waitFor()
        }
        await app.screenshot('abliteration-02-picker')
        await page.keyboard.press('Escape')
      }
    )

    let sessionAffinity
    for (const modelId of MODEL_IDS) {
      await step(`${modelId}: native streaming, reasoning and read-tool continuation`, async () => {
        await openModel(app, modelId)
        const { levels } = await app.rpc({ type: 'get_available_thinking_levels' })
        const reasoning = modelId === 'abliterated-model-large' ? 'high' : 'low'
        assert.ok(levels.includes(reasoning))
        await app.rpc({ type: 'set_thinking_level', level: reasoning })
        const state = await app.rpc({ type: 'get_state' })
        assert.equal(state.model.input.includes('image'), modelId === MODEL_IDS[0])
        const from = server.requests.length
        if (!LIVE) {
          server.queue(
            turn.toolCall('read', { path: PROOF_FILE }, { thinking: 'Read the proof.' }),
            turn.text(TOOL_MARKER)
          )
        }
        await sendVisible(app, PROMPT)
        await settleVisible(app)
        const result = await app.agentState()
        assert.ok(assistantText(result).includes(TOOL_MARKER), 'model returns the file contents')
        assert.ok(
          result.entries.some(
            (entry) => entry.message.role === 'toolResult' && entry.message.toolName === 'read'
          ),
          'native read tool ran'
        )
        if (!LIVE) {
          const requests = server.requests.slice(from)
          assert.equal(requests.length, 2)
          const first = requests[0]
          assert.equal(first.body.model, modelId)
          assert.equal(first.body.reasoning_effort, reasoning)
          assert.equal(first.headers.authorization, `Bearer ${API_KEY}`)
          assert.ok(first.headers['x-session-affinity'])
          sessionAffinity ??= first.headers['x-session-affinity']
          assert.equal(
            requests[1].headers['x-session-affinity'],
            first.headers['x-session-affinity']
          )
          assert.ok(inspectRequest(requests[1]).toolResults[0].text.includes(TOOL_MARKER))
          assert.equal(first.body.prompt_cache_retention, undefined)
        }
      })
    }

    await step('every Large V2 effort is visible in the composer', async () => {
      await openModel(app, MODEL_IDS[1])
      await page.getByRole('button', { name: /^Thinking level:/ }).click()
      const choices = page.getByRole('menuitemradio')
      assert.equal(await choices.count(), 6)
      for (const label of ['Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max']) {
        await choices.getByText(label, { exact: true }).waitFor()
      }
      await app.screenshot('abliteration-03-large-v2-efforts')
      await page.keyboard.press('Escape')
    })

    await step('every offered reasoning level reaches the provider', async () => {
      for (const modelId of LIVE ? [MODEL_IDS[1]] : MODEL_IDS) {
        await app.rpc({ type: 'set_model', provider: PROVIDER, modelId })
        const { levels } = await app.rpc({ type: 'get_available_thinking_levels' })
        for (const level of levels) {
          await app.rpc({ type: 'set_thinking_level', level })
          const from = server.requests.length
          const entryCount = (await app.agentState()).entries.length
          if (!LIVE) server.queue(turn.text('ok'))
          await app.rpc({
            type: 'prompt',
            message: 'Reply with just: ok',
            ...(!LIVE && modelId === MODEL_IDS[0] ? { images: [IMAGE] } : {})
          })
          await waitUntil(async () => (await app.agentState()).entries.length > entryCount, {
            label: 'native prompt accepted'
          })
          await settleVisible(app)
          if (LIVE) {
            const entries = (await app.agentState()).entries.slice(entryCount)
            assert.ok(assistantText({ entries }).toLowerCase().includes('ok'))
            console.log(`      Large V2 ${level}: completed`)
          } else {
            const request = await server.waitForRequest(undefined, { from })
            assert.equal(request.body.reasoning_effort, level === 'off' ? 'none' : level)
            assert.equal(inspectRequest(request).imageCount > 0, modelId === MODEL_IDS[0])
          }
        }
      }
    })

    await step('new sessions use a different cache-affinity value', async () => {
      if (LIVE) return
      await openAnotherWorkspace(app, { model: `${PROVIDER}/${MODEL_IDS[0]}` })
      const from = server.requests.length
      server.queue(turn.text('ok'))
      await sendVisible(app, 'Reply with just: ok')
      await settleVisible(app)
      const request = await server.waitForRequest(undefined, { from })
      assert.ok(request.headers['x-session-affinity'])
      assert.notEqual(request.headers['x-session-affinity'], sessionAffinity)
    })
    await app.screenshot(LIVE ? 'abliteration-03-live' : 'abliteration-03-transcript')
  },
  {
    launch: {
      exe: process.env.QA_PACKAGED_EXE,
      env: { ABLIT_KEY: undefined },
      outDir: reportShotsDir('abliteration')
    }
  }
)
