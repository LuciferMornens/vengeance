// Engine 2 image turns on a text-only model: the composer says the message will be refused, the refused turn
// shows its error under the message and reaches no provider, and `imageModel` routes the turn to a model that
// reads images (or names itself when it cannot). Local fake provider, temporary accounts, no Python kernel.
//
//   npm run build && node scripts/qa/engines/image-refusal.qa.mjs
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makePng, until } from '../chat/helpers.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import {
  createEngineFixture,
  engineSettings,
  PRIME_MODELS,
  PRIME_PROVIDER
} from './integration-fixture.mjs'

const SUITE = 'engine2-image-refusal'
const TEXT_MODEL = 'Engine2 QA Reasoning'
const VISION_ID = 'prime-qa-vision'
const VISION_NAME = 'Engine2 QA Vision'
const IMAGE = makePng(16, 16, [200, 40, 40])
const PROMPT = 'Describe this image.'
const ROUTED_ANSWER = 'A red square.'

async function step(label, action) {
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label}`)
  return result
}

/** A model of the fixture's provider that reads images, for `imageModel` to name. */
async function addVisionModel(directory) {
  const path = join(directory, 'models.json')
  const configured = JSON.parse(await readFile(path, 'utf8'))
  const provider = configured.providers[PRIME_PROVIDER]
  const [textModel] = provider.models
  provider.models.push({ ...textModel, id: VISION_ID, name: VISION_NAME, input: ['text', 'image'] })
  await writeFile(path, `${JSON.stringify(configured, null, 2)}\n`)
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

/** The composer's note under the pasted image, once it reads `tone`. */
async function imageNotice(app, tone) {
  const notice = app.page.locator(`[data-image-notice="${tone}"]`)
  await notice.waitFor()
  return notice.innerText()
}

async function setImageModel(app, workspace, value) {
  await engineSettings(app, 'prime', 'settings:set', {
    scope: 'global',
    cwd: workspace,
    path: ['imageModel'],
    value
  })
}

/** Send the pasted image; resolves with the turn's provider requests once the conversation is idle again. */
async function sendImage(app, server) {
  const from = server.requests.length
  await app.send(PROMPT)
  await app.waitForSettle()
  return server.requests.slice(from).filter((request) => request.method === 'POST')
}

/** The refused message stays in the transcript with its image, and no response follows it. */
async function assertRefused(app, requests, refusal) {
  assert.equal(requests.length, 0, 'a refused turn reaches no provider')
  const state = await app.agentState()
  assert.equal(state.phase, 'idle')
  const last = state.entries.at(-1).message
  assert.equal(last.role, 'user', 'no response follows the refused message')
  assert.equal(last.content.filter((block) => block.type === 'image').length, 1)
  assert.match(state.turnError.message, refusal)
}

async function suiteBody(fixture, app, checks) {
  const workspace = await fixture.root.folder('workspace', { 'README.md': '# Image refusal QA\n' })
  await step('open an Engine 2 conversation on a text-only model', async () => {
    await app.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off'
      }
    })
    const state = await app.rpc({ type: 'get_state' })
    assert.deepEqual(state.model.input, ['text'])
  })

  await checks.check('the composer says Engine 2 will refuse the image', async () => {
    await pasteImage(app)
    const text = await imageNotice(app, 'danger')
    assert.match(
      text,
      new RegExp(`^${TEXT_MODEL} can’t read images, so Engine 2 will refuse this message\\.`)
    )
    assert.match(text, /Choose a model that reads images, or set an image model\.$/)
    await app.screenshot('engine2-image-refusal-notice')
  })

  await checks.check('the refused turn shows its error and reaches no provider', async () => {
    const requests = await sendImage(app, fixture.primeServer)
    await assertRefused(app, requests, /^This turn attaches images, but the selected model/)
    await app.page.getByText(`${TEXT_MODEL} can’t read images`, { exact: true }).waitFor()
    await app.page.getByText(/^Engine 2 didn’t send this message\./).waitFor()
    await app.page.getByRole('button', { name: 'Change model', exact: true }).waitFor()
    await app.screenshot('engine2-image-refusal-turn')
  })

  await checks.check('Set image model opens Engine 2’s image model setting', async () => {
    await app.page.getByRole('button', { name: 'Set image model', exact: true }).click()
    const row = app.page.locator('[id="setting-imageModel"]')
    await row.getByText('Image model', { exact: true }).waitFor()
    await app.screenshot('engine2-image-model-setting')
    await app.test('closeSettings')
    await row.waitFor({ state: 'detached' })
  })

  await checks.check('a usable image model answers the image turn', async () => {
    await setImageModel(app, workspace, `${PRIME_PROVIDER}/${VISION_ID}`)
    await pasteImage(app)
    assert.equal(
      await imageNotice(app, 'info'),
      `${TEXT_MODEL} can’t read images, so ${VISION_NAME} will answer this message.`
    )
    await app.screenshot('engine2-image-model-notice')
    fixture.primeServer.queue(turn.text(ROUTED_ANSWER))
    const requests = await sendImage(app, fixture.primeServer)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.model, VISION_ID)
    assert.equal(inspectRequest(requests[0]).imageCount, 1)
    await app.page.getByText(ROUTED_ANSWER, { exact: true }).waitFor()
    const state = await app.agentState()
    assert.equal(state.turnError, undefined)
    assert.equal(state.model.id, PRIME_MODELS.reasoning, 'the session keeps its own model')
    await app.screenshot('engine2-image-model-answer')
  })

  await checks.check('an image model that cannot read images is refused by name', async () => {
    const reference = `${PRIME_PROVIDER}/${PRIME_MODELS.small}`
    await setImageModel(app, workspace, reference)
    await pasteImage(app)
    const notice = await imageNotice(app, 'danger')
    assert.match(
      notice,
      new RegExp(`its image model “${reference}” isn’t a signed-in model that can\\.`)
    )
    assert.match(notice, /Choose a model that reads images, or fix the image model\.$/)
    const requests = await sendImage(app, fixture.primeServer)
    await assertRefused(app, requests, /^imageModel ".+" could not be resolved/)
    await app.page.getByText('The image model isn’t available', { exact: true }).waitFor()
    await app.screenshot('engine2-image-model-unusable')
  })

  await checks.check('no unexpected app errors', async () => app.assertNoErrors())
}

console.log(`▶ ${SUITE} (fake provider, temporary accounts)`)
const fixture = await createEngineFixture()
let app = null
let failure = null
const checks = softSteps(step, { app: () => app, name: SUITE })

try {
  await addVisionModel(fixture.primeDirectory)
  app = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    exe: process.env.QA_PACKAGED_EXE,
    outDir: reportShotsDir(SUITE)
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
