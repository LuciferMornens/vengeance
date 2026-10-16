// REAL mode, read-only: the user's real engine config (guarded; checked unchanged on close). No
// model calls. The Engine's own list (RPC get_available_models of a --no-session engine) is the
// truth; Vengeance must show the same models with the same facts in every model surface:
//   composer picker, palette Models page, Settings → Models (default model, per-model thinking).
// Classifier/image models (models.md) must never be offered as chat models.
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { REAL_AGENT_DIR } from '../lib/agent-dir.mjs'
import { runSuite } from '../lib/suite.mjs'
import { enginePackageDir } from '../settings/engine-sdk.mjs'
import { LAUNCH, missing, softSteps, waitUntil } from './helpers.mjs'

const ENGINE_SDK = pathToFileURL(join(enginePackageDir(), 'dist', 'index.js')).href
/** settings.json of the user (read for the expectation only). */
const EXPECTED_DEFAULT = 'anthropic/claude-opus-5-5'
const EXPECTED_DEFAULT_THINKING = 'high'

/** Same rule as renderer lib/format.ts formatTokens (the ModelRow context column). */
function formatTokens(n) {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

const keyOf = (m) => `${m.provider}/${m.id}`

/** Rows of an open ModelRow list (composer picker / palette): what the user can read per model. */
function readModelRows(list) {
  return list.locator('[cmdk-item]').evaluateAll((items) =>
    items.map((item) => ({
      key: item.dataset.value,
      name: item.querySelector('.truncate')?.textContent ?? '',
      reasoning: !!item.querySelector('[aria-label="Reasoning"]'),
      image: !!item.querySelector('[aria-label="Image input"]'),
      context: item.querySelector('.w-10.text-right')?.textContent ?? '',
      current: (item.textContent ?? '').includes('Current model')
    }))
  )
}

/** Compare displayed rows with the engine's models; returns readable differences. */
function rowDifferences(rows, engineModels) {
  const byKey = new Map(engineModels.map((m) => [keyOf(m), m]))
  const diffs = []
  for (const row of rows) {
    const model = byKey.get(row.key)
    if (!model) continue
    if (row.name !== model.name) diffs.push(`${row.key}: name "${row.name}" ≠ "${model.name}"`)
    if (row.reasoning !== !!model.reasoning)
      diffs.push(`${row.key}: reasoning badge ${row.reasoning}`)
    const image = model.input.includes('image')
    if (row.image !== image) diffs.push(`${row.key}: image badge ${row.image}`)
    if (row.context !== formatTokens(model.contextWindow)) {
      diffs.push(`${row.key}: context "${row.context}" ≠ ${formatTokens(model.contextWindow)}`)
    }
  }
  return diffs
}

/**
 * Non-chat models of the real catalog, read with the engine SDK and an EMPTY temp auth file
 * (no credentials are read; only the catalog matters here).
 */
async function nonChatModelKeys() {
  const scratch = await mkdtemp(join(tmpdir(), 'vengeance-qa-catalog-'))
  try {
    // Copies, so nothing the SDK might write can land in the real agent dir.
    for (const name of ['models.json', 'models-store.json']) {
      await copyFile(join(REAL_AGENT_DIR, name), join(scratch, name)).catch(() => undefined)
    }
    const sdk = await import(ENGINE_SDK)
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(scratch, 'auth.json'),
      modelsPath: join(scratch, 'models.json'),
      allowModelNetwork: false,
      refreshOnCreate: false
    })
    const chat = new Set(runtime.getModels().map(keyOf))
    const nonChat = [
      ...runtime.getModelsOfType('classifier'),
      ...runtime.getModelsOfType('image')
    ].map(keyOf)
    return nonChat.filter((key) => !chat.has(key))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Provider headings in the pickers (provider-name.ts): the two ChatGPT sign-ins read as ChatGPT. */
const shownName = (p) =>
  p.id === 'openai-codex'
    ? 'ChatGPT \u00b7 Codex'
    : p.id === 'openai' && p.status.usingOAuth
      ? 'ChatGPT'
      : p.name

await runSuite(
  'auth-model-parity-real',
  async ({ app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    let agentId
    let engineModels
    let engineKeys
    let catalog

    await step('open a --no-session workspace on the real config', async () => {
      ;({ agentId } = await app.openWorkspace())
      catalog = await app.invoke('settings:catalog')
      if (catalog.providers.find((provider) => provider.id === 'openai')?.status.usingOAuth) {
        // Startup fetches account offerings in the background, narrowing every model surface.
        await waitUntil(
          async () => {
            const text = await readFile(join(app.userData, 'account-models.json'), 'utf8').catch(
              (error) => {
                if (error.code === 'ENOENT') return null
                throw error
              }
            )
            return text && Array.isArray(JSON.parse(text).ids)
          },
          { label: 'the native account model lookup to finish' }
        )
      }
      engineModels = (await app.rpc({ type: 'get_available_models' }, agentId)).models
      engineKeys = engineModels.map(keyOf)
      catalog = await app.invoke('settings:catalog')
      console.log(
        `      engine: ${engineKeys.length} models from ${new Set(engineModels.map((m) => m.provider)).size} providers; catalog: ${catalog.models.length} models (${catalog.models.filter((m) => m.available).length} available)`
      )
      const mainRss = await app.app.evaluate(() => process.memoryUsage().rss)
      console.log(
        `      main process RSS after the catalog load: ${Math.round(mainRss / 2 ** 20)} MB`
      )
      assert.ok(engineKeys.length > 0)
    })

    await step('current model = settings default, at its per-model thinking level', async () => {
      const state = await app.rpc({ type: 'get_state' }, agentId)
      assert.equal(keyOf(state.model), EXPECTED_DEFAULT)
      assert.equal(state.thinkingLevel, EXPECTED_DEFAULT_THINKING)
      const ui = await app.agentState(agentId)
      assert.equal(keyOf(ui.model), EXPECTED_DEFAULT)
      assert.equal(ui.thinkingLevel, EXPECTED_DEFAULT_THINKING)
      const pill = page.getByRole('button', { name: /^Thinking level:/ })
      assert.equal(await pill.getAttribute('aria-label'), 'Thinking level: High')
      await page.getByRole('button', { name: `Model: ${state.model.name}` }).waitFor()
    })

    await step(
      'thinking levels of the current model: engine = catalog = thinking menu',
      async () => {
        const { levels } = await app.rpc({ type: 'get_available_thinking_levels' }, agentId)
        const current = catalog.models.find((m) => keyOf(m) === EXPECTED_DEFAULT)
        assert.deepEqual(current.thinkingLevels, levels)
        await page.getByRole('button', { name: /^Thinking level:/ }).click()
        const items = await page.getByRole('menuitemradio').count()
        assert.equal(items, levels.length)
        await app.screenshot('real-01-thinking-menu')
        await page.keyboard.press('Escape')
      }
    )

    // BUG auth-12: the config-side catalog (models.ts createRuntime → ModelRuntime.create +
    // refresh) applies the cached models-store.json overlay, the running engine reports the
    // bundled entry: seen claude-sonnet-5-5 cacheRead 0.1 in Settings vs 0.2 in the engine.
    await soft.step(
      'Settings catalog: available models = the engine list, same facts',
      async () => {
        const available = catalog.models.filter((m) => m.available && !m.fromExtension)
        assert.deepEqual(missing(engineKeys, available.map(keyOf)), [], 'engine models missing')
        assert.deepEqual(missing(available.map(keyOf), engineKeys), [], 'extra catalog models')
        const byKey = new Map(available.map((m) => [keyOf(m), m]))
        const diffs = []
        for (const model of engineModels) {
          const info = byKey.get(keyOf(model))
          for (const field of ['name', 'contextWindow', 'maxTokens', 'reasoning', 'api']) {
            if (info[field] !== model[field]) diffs.push(`${keyOf(model)}.${field}`)
          }
          if (JSON.stringify(info.input) !== JSON.stringify(model.input))
            diffs.push(`${keyOf(model)}.input`)
          if (!isDeepStrictEqual(info.cost, model.cost)) {
            diffs.push(
              `${keyOf(model)}.cost: ${JSON.stringify(info.cost)} vs engine ${JSON.stringify(model.cost)}`
            )
          }
        }
        assert.deepEqual(diffs, [])
      }
    )

    await step('no classifier/image-only model is offered as a chat model', async () => {
      const nonChat = await nonChatModelKeys()
      assert.ok(nonChat.length > 0, 'the catalog has classifier/image models')
      const offered = new Set([...engineKeys, ...catalog.models.map(keyOf)])
      assert.deepEqual(
        nonChat.filter((key) => offered.has(key)),
        []
      )
      const typesafe = catalog.providers.find((p) => p.id === 'typesafe')
      assert.equal(typesafe?.modelCount, 0, 'TypeSafe (classifier only) has no chat models')
    })

    await soft.step('composer picker: same models, names, badges, context, grouping', async () => {
      await page.getByRole('button', { name: /^Model: / }).click()
      const list = page.locator('[cmdk-list]').last()
      await list.locator('[cmdk-item]').first().waitFor()
      const rows = await readModelRows(list)
      assert.deepEqual(
        rows.map((r) => r.key),
        engineKeys,
        'same models in engine order'
      )
      assert.deepEqual(rowDifferences(rows, engineModels), [])
      assert.deepEqual(
        rows.filter((r) => r.current).map((r) => r.key),
        [EXPECTED_DEFAULT]
      )
      const headings = await list.locator('[cmdk-group-heading]').allInnerTexts()
      const providers = [...new Set(engineModels.map((m) => m.provider))]
      assert.equal(headings.length, providers.length, `groups: ${headings.join(', ')}`)
      await app.screenshot('real-02-composer-picker')
      await page.keyboard.press('Escape')
    })

    // The two ChatGPT sign-ins read as ChatGPT (provider-name.ts): `openai` signed in with ChatGPT is "ChatGPT",
    // `openai-codex` is "ChatGPT · Codex"; every other heading is the engine provider name.
    await soft.step(
      'composer picker: group headings are the engine provider names (ChatGPT sign-ins named as such)',
      async () => {
        await page.getByRole('button', { name: /^Model: / }).click()
        const list = page.locator('[cmdk-list]').last()
        await list.locator('[cmdk-item]').first().waitFor()
        // The heading's text without its decorative (aria-hidden) provider tile.
        const headings = await list.locator('[cmdk-group-heading]').evaluateAll((els) =>
          els.map((el) => {
            const copy = el.cloneNode(true)
            copy.querySelectorAll('[aria-hidden]').forEach((tile) => tile.remove())
            return copy.textContent.trim()
          })
        )
        const names = new Map(catalog.providers.map((p) => [p.id, shownName(p)]))
        const expected = [...new Set(engineModels.map((m) => m.provider))].map(
          (id) => names.get(id) ?? id
        )
        await page.keyboard.press('Escape')
        assert.deepEqual(headings, expected)
      }
    )

    await soft.step('palette Models page: same models, names, badges, context', async () => {
      await app.test('setPalette', true)
      await page
        .getByRole('option', { name: /Change model/ })
        .first()
        .click()
      const list = page.locator('[cmdk-list]').last()
      await list.locator('[cmdk-item][data-value*="/"]').first().waitFor()
      const rows = (await readModelRows(list)).filter((r) => r.key?.includes('/'))
      assert.deepEqual(
        rows.map((r) => r.key),
        engineKeys
      )
      assert.deepEqual(rowDifferences(rows, engineModels), [])
      assert.deepEqual(
        rows.filter((r) => r.current).map((r) => r.key),
        [EXPECTED_DEFAULT]
      )
      await app.screenshot('real-03-palette-models')
      await page.keyboard.press('Escape')
      await app.test('setPalette', false)
    })

    await step(
      'Settings → Models: default model shows Claude Opus, thinking entry shows High',
      async () => {
        await app.test('openSettings', 'models')
        await page.getByRole('heading', { name: 'Models', exact: true }).waitFor()
        const current = catalog.models.find((m) => keyOf(m) === EXPECTED_DEFAULT)
        const defaultRow = page.locator('[id="setting-defaultModel"]')
        await defaultRow.getByText(current.name, { exact: true }).waitFor()
        assert.equal(await defaultRow.getByText('Needs sign-in').count(), 0)
        const thinkingRow = page.locator('[id="setting-modelThinkingLevels"]')
        await thinkingRow.getByText(current.name, { exact: true }).waitFor()
        assert.equal((await thinkingRow.getByRole('combobox').first().innerText()).trim(), 'High')
        await app.screenshot('real-04-settings-models')
      }
    )

    await soft.step(
      'Settings → Models default-model picker: available groups = engine list',
      async () => {
        const defaultRow = page.locator('[id="setting-defaultModel"]')
        const current = catalog.models.find((m) => keyOf(m) === EXPECTED_DEFAULT)
        await defaultRow.getByRole('button', { name: new RegExp(current.name) }).click()
        const options = page.getByRole('option')
        await options.first().waitFor()
        const count = await options.count()
        assert.equal(count, catalog.models.length, 'every catalog model is listed')
        const lockedGroups = await page
          .locator('[cmdk-group-heading]:has(svg.lucide-lock)')
          .allInnerTexts()
        const availableProviders = new Set(engineModels.map((m) => m.provider))
        const names = new Map(catalog.providers.map((p) => [p.id, shownName(p)]))
        for (const provider of availableProviders) {
          assert.ok(!lockedGroups.includes(names.get(provider)), `${provider} is not locked`)
        }
        await app.screenshot('real-05-settings-default-picker')
        await page.keyboard.press('Escape')
        await app.test('closeSettings')
      }
    )

    await step('nothing was written: the session is still on the default', async () => {
      const state = await app.rpc({ type: 'get_state' }, agentId)
      assert.equal(keyOf(state.model), EXPECTED_DEFAULT)
      await waitUntil(async () => !(await app.appState()).ui.settingsOpen, {
        label: 'settings closed'
      })
    })

    soft.finish()
  },
  { mode: 'real', launch: LAUNCH }
)
