// Settings → Agent behavior (images, network) and Sessions & context (session directory): the real
// controls, the JSON written, and what the Engine sends to the fake LLM or stores on disk.
//
//   node scripts/qa/settings/agent-images-network.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { anthropicImages, imageSize, solidPngBase64 } from './images.mjs'
import {
  choose,
  closeSettings,
  fill,
  LAUNCH,
  newSessionIn,
  openSettings,
  readJsonOrNull,
  restartFromToast,
  sendAndCapture,
  setSwitch,
  softSteps,
  waitFor,
  waitForJsonValue
} from './settings-ui.mjs'

const WIDE = { width: 2600, height: 24 }

/** Prompt the active (vision) agent with one image and return the request the model received. */
async function promptWithImage(app, server, text) {
  const from = server.requests.length
  server.queue(turn.text('Saw it.'))
  const data = solidPngBase64(WIDE.width, WIDE.height)
  await app.rpc({
    type: 'prompt',
    message: text,
    images: [{ type: 'image', data, mimeType: 'image/png' }]
  })
  await app.waitForSettle()
  return server.waitForRequest(undefined, { from })
}

await runSuite(
  'settings-agent-images-network',
  async (context) => {
    const { server, agentDir, app } = context
    const { check: step, finish } = softSteps(context, 'settings-agent-images-network')
    const settingsPath = agentDir.path('settings.json')
    let agentId
    let cwd

    await step('open a session on the vision model', async () => {
      ;({ agentId, cwd } = await app.openWorkspace({
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.vision}` }
      }))
    })

    await step(
      'Resize images (default on): a 2600 px wide image reaches the model ≤ 2000 px',
      async () => {
        const request = await promptWithImage(app, server, 'resize default')
        const size = imageSize(anthropicImages(request.body).at(-1))
        assert.ok(size && size.width <= 2000, `sent ${JSON.stringify(size)}`)
      }
    )

    await step('Resize images off is written; the image is sent at full size', async () => {
      await openSettings(app, 'Agent behavior')
      await setSwitch(app, 'images.autoResize', false)
      await waitForJsonValue(settingsPath, 'images', { autoResize: false })
      await restartFromToast(app, agentId)
      await closeSettings(app)
      const request = await promptWithImage(app, server, 'resize off')
      const size = imageSize(anthropicImages(request.body).at(-1))
      assert.deepEqual(size, WIDE)
    })

    await step(
      'Block images on is written; the model receives no image, only the placeholder',
      async () => {
        await openSettings(app, 'Agent behavior')
        await setSwitch(app, 'images.blockImages', true)
        await waitForJsonValue(settingsPath, 'images', { autoResize: false, blockImages: true })
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const request = await promptWithImage(app, server, 'blocked')
        const sent = inspectRequest(request)
        assert.equal(sent.imageCount, 0)
        assert.match(JSON.stringify(request.body.messages.at(-1)), /Image reading is disabled\./)
      }
    )

    await step(
      'HTTP idle timeout 1500 ms is written; a stalled stream is cut off by the Engine',
      async () => {
        await openSettings(app, 'Agent behavior')
        await setSwitch(app, 'retry.enabled', false)
        await fill(app, 'httpIdleTimeoutMs', 1500)
        await waitForJsonValue(settingsPath, 'httpIdleTimeoutMs', 1500)
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const from = server.requests.length
        server.queue(turn.hang({ text: 'partial answer' }))
        const started = Date.now()
        await app.send('stall please')
        const request = await server.waitForRequest(undefined, { from })
        const outcome = await server
          .waitForOutcome(request, { timeoutMs: 15_000 })
          .catch(async (error) => {
            await app.page.getByRole('button', { name: 'Stop' }).click()
            throw error
          })
        assert.equal(outcome, 'aborted')
        assert.ok(Date.now() - started < 10_000, `cut after ${Date.now() - started} ms`)
        await app.waitForSettle()
      }
    )

    await step(
      'Request timeout 90000 ms is written and becomes the SDK timeout of each request',
      async () => {
        await openSettings(app, 'Agent behavior')
        await fill(app, 'httpIdleTimeoutMs', '')
        await fill(app, 'retry.provider.timeoutMs', 90000)
        await waitForJsonValue(settingsPath, 'retry', {
          enabled: false,
          provider: { timeoutMs: 90000 }
        })
        assert.equal((await readJsonOrNull(settingsPath)).httpIdleTimeoutMs, undefined)
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const request = await sendAndCapture(app, server, 'timeout header', turn.text('ok'))
        // The Anthropic SDK announces its request timeout (seconds); the default is the 300 s idle timeout.
        assert.equal(request.headers['x-stainless-timeout'], '90')
      }
    )

    await step('HTTP proxy (global) is written and routes Engine traffic through it', async () => {
      await openSettings(app, 'Agent behavior')
      await fill(app, 'retry.provider.timeoutMs', '')
      // A proxy nobody listens on: if the Engine honors it, the model is never reached.
      await fill(app, 'httpProxy', 'http://127.0.0.1:9')
      await waitForJsonValue(settingsPath, 'httpProxy', 'http://127.0.0.1:9')
      await restartFromToast(app, agentId)
      await closeSettings(app)
      const from = server.requests.length
      server.queue(turn.text('should not arrive through a dead proxy'))
      await app.send('through the proxy')
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 0, 'request bypassed the proxy')
      server.reset()
      await openSettings(app, 'Agent behavior')
      await fill(app, 'httpProxy', '')
      await waitFor(
        async () => !('httpProxy' in ((await readJsonOrNull(settingsPath)) ?? {})),
        'httpProxy removed'
      )
      await restartFromToast(app, agentId)
    })

    await step('Transport and WebSocket timeout round-trip to settings.json', async () => {
      await choose(app, 'transport', 'Server-sent events')
      await waitForJsonValue(settingsPath, 'transport', 'sse')
      await fill(app, 'websocketConnectTimeoutMs', 4000)
      await waitForJsonValue(settingsPath, 'websocketConnectTimeoutMs', 4000)
      await closeSettings(app)
    })

    await step('Session directory is written; a new session stores its file there', async () => {
      const sessions = agentDir.path('../custom-sessions')
      await openSettings(app, 'Sessions & context')
      await fill(app, 'sessionDir', sessions)
      await waitForJsonValue(settingsPath, 'sessionDir', sessions)
      await closeSettings(app)
      const fresh = await newSessionIn(app, cwd)
      await sendAndCapture(app, server, 'store me', turn.text('stored'))
      const state = await app.rpc({ type: 'get_state' }, fresh)
      assert.ok(state.sessionFile, 'session file')
      assert.ok(
        resolve(state.sessionFile).toLowerCase().startsWith(resolve(sessions).toLowerCase()),
        `${state.sessionFile} not in ${sessions}`
      )
      await waitFor(() => existsSync(state.sessionFile), 'session file written')
      assert.ok(existsSync(dirname(state.sessionFile)))
      await app.screenshot('settings-sessions')
    })

    finish()
  },
  { launch: LAUNCH }
)
