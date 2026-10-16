// Chat: model switching from the footer picker, the palette, Ctrl+L, /model, and cycling (Ctrl+P),
// each proven by the model id of the NEXT request the engine sends.
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  closePalette,
  THINKING_BUDGETS,
  composer,
  pickModelInFooter,
  sendAndCapture,
  sleep,
  softSteps,
  submitCommand,
  until
} from './helpers.mjs'

const modelIs = (app, id) => async () => (await app.agentState())?.model?.id === id

async function engineModel(app) {
  return (await app.rpc({ type: 'get_state' })).model.id
}

async function assertNextRequestModel(app, server, id, prompt) {
  const { sent } = await sendAndCapture(app, server, prompt)
  assert.equal(sent.model, id, `next request uses ${id}`)
  assert.equal(await engineModel(app), id, 'engine get_state model')
  const pill = await app.page.getByRole('button', { name: /^Model:/ }).getAttribute('aria-label')
  const expectedName = (await app.agentState()).model.name
  assert.equal(pill, `Model: ${expectedName}`, 'footer pill shows the model')
}

await runSuite(
  'chat-models',
  async ({ server, app, step }) => {
    const checks = softSteps(step, app)
    await step('open on qa-reasoning', async () => {
      await app.openWorkspace({ args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}` } })
      const { sent } = await sendAndCapture(app, server, 'baseline')
      assert.equal(sent.model, FAKE_MODELS.reasoning)
    })

    await step('footer picker → qa-vision', async () => {
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.vision)
      await assertNextRequestModel(app, server, FAKE_MODELS.vision, 'after footer pick')
    })

    await step('Ctrl+L opens the footer picker; Enter on a search hit switches', async () => {
      await composer(app).focus()
      await app.page.keyboard.press('Control+l')
      const search = app.page.getByPlaceholder('Search models…')
      await search.waitFor()
      await app.screenshot('model-picker-ctrl-l')
      await search.fill('qa-small')
      await app.page.keyboard.press('Enter')
      await until(modelIs(app, FAKE_MODELS.small), { label: 'qa-small via Ctrl+L' })
      await assertNextRequestModel(app, server, FAKE_MODELS.small, 'after ctrl l')
    })

    await checks.check('palette Models page finds a model by its id', async () => {
      await composer(app).focus()
      await app.page.keyboard.press('Control+k')
      const input = app.page.getByPlaceholder('Search or run a command…')
      await input.waitFor()
      await input.fill('Change model')
      await app.page.keyboard.press('Enter')
      const modelSearch = app.page.getByPlaceholder('Search models…')
      await modelSearch.waitFor()
      await modelSearch.fill('qa-openai')
      await sleep(300)
      const hits = await app.page.locator('[cmdk-item]').count()
      await app.screenshot('palette-model-search-by-id')
      await closePalette(app)
      assert.ok(hits > 0, 'searching "qa-openai" lists QA OpenAI')
    })

    await step('palette: Ctrl+K → Change model → QA OpenAI (by name)', async () => {
      await composer(app).focus()
      await app.page.keyboard.press('Control+k')
      const input = app.page.getByPlaceholder('Search or run a command…')
      await input.waitFor()
      await input.fill('Change model')
      await app.page.keyboard.press('Enter')
      const modelSearch = app.page.getByPlaceholder('Search models…')
      await modelSearch.waitFor()
      await modelSearch.fill('QA OpenAI')
      await app.page
        .locator(`[cmdk-item][data-value="${FAKE_PROVIDER}/${FAKE_MODELS.openai}"]`)
        .click()
      await until(modelIs(app, FAKE_MODELS.openai), { label: 'qa-openai via palette' })
      await assertNextRequestModel(app, server, FAKE_MODELS.openai, 'after palette')
    })

    await step('palette thinking page sets the level', async () => {
      await composer(app).focus()
      await app.page.keyboard.press('Control+k')
      const input = app.page.getByPlaceholder('Search or run a command…')
      await input.fill('Thinking level')
      await app.page.keyboard.press('Enter')
      await app.page.getByPlaceholder('Choose a thinking level…').waitFor()
      await app.page.locator('[cmdk-item]', { hasText: /^High/ }).first().click()
      await until(async () => (await app.agentState()).thinkingLevel === 'high', {
        label: 'high via palette'
      })
      const { sent } = await sendAndCapture(app, server, 'palette thinking')
      assert.equal(sent.reasoningEffort, 'high')
    })

    await step('/model provider/id:level switches model and level', async () => {
      await submitCommand(app, `/model ${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}:low`)
      await until(modelIs(app, FAKE_MODELS.reasoning), { label: '/model switch' })
      await until(async () => (await app.agentState()).thinkingLevel === 'low', {
        label: '/model :low'
      })
      const { sent } = await sendAndCapture(app, server, 'after slash model')
      assert.equal(sent.model, FAKE_MODELS.reasoning)
      assert.equal(sent.thinking?.budget_tokens, THINKING_BUDGETS.low)
      assert.equal(
        server.requests.filter((r) => r.body?.messages?.at(-1)?.content?.includes?.('/model'))
          .length,
        0,
        '/model never reaches the model'
      )
    })

    await step('/model with no args opens the palette models page', async () => {
      await submitCommand(app, '/model')
      await app.page.getByPlaceholder('Search models…').waitFor()
      await closePalette(app)
    })

    await step('Ctrl+P cycles forward through all models; the request follows', async () => {
      const { models } = await app.rpc({ type: 'get_available_models' })
      const ids = models.map((m) => m.id)
      const start = (await app.agentState()).model.id
      await composer(app).focus()
      await app.page.keyboard.press('Control+p')
      const expected = ids[(ids.indexOf(start) + 1) % ids.length]
      await until(modelIs(app, expected), { label: `Ctrl+P → ${expected}` })
      await app.screenshot('model-cycle-toast')
      await assertNextRequestModel(app, server, expected, 'after cycle')
    })

    await checks.check(
      'cycle backward (engine: Alt+P on Windows) moves to the previous model',
      async () => {
        const { models } = await app.rpc({ type: 'get_available_models' })
        const ids = models.map((m) => m.id)
        const start = (await app.agentState()).model.id
        const expected = ids[(ids.indexOf(start) - 1 + ids.length) % ids.length]
        await composer(app).focus()
        await app.page.keyboard.press('Alt+p')
        await sleep(600)
        assert.equal((await app.agentState()).model.id, expected, 'Alt+P cycles backward')
      }
    )

    checks.assertAll()
  },
  { launch: { outDir: SHOTS_DIR } }
)

await runSuite(
  'chat-models-scoped-cycle',
  async ({ server, app, step }) => {
    await step('open with enabledModels = [qa-reasoning, qa-vision]', async () => {
      await app.openWorkspace({ args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}` } })
    })

    await step('Ctrl+P cycles within the scoped models only', async () => {
      const seen = []
      for (let i = 0; i < 3; i++) {
        const before = (await app.agentState()).model.id
        await composer(app).focus()
        await app.page.keyboard.press('Control+p')
        await until(async () => (await app.agentState()).model.id !== before, {
          label: 'cycle step'
        })
        seen.push((await app.agentState()).model.id)
      }
      assert.deepEqual(seen, [FAKE_MODELS.vision, FAKE_MODELS.reasoning, FAKE_MODELS.vision])
      const { sent } = await sendAndCapture(app, server, 'scoped')
      assert.equal(sent.model, FAKE_MODELS.vision)
    })
  },
  {
    launch: { outDir: SHOTS_DIR },
    agentDir: {
      settings: {
        enabledModels: [
          `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`,
          `${FAKE_PROVIDER}/${FAKE_MODELS.vision}`
        ]
      }
    }
  }
)
