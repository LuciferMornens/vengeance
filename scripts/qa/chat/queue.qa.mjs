// Chat: Stop during streaming and during a tool call, steering and follow-up queueing (Enter /
// Alt+Enter), the queue modes from Settings (one-at-a-time vs all) as seen in the requests, and the
// queued-message chips (remove one, Edit queue, Stop restores the queue into the editor).
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { SHOTS_DIR, composer, sleep, softSteps, until } from './helpers.mjs'

const userTexts = (request) =>
  inspectRequest(request)
    .messages.filter((message) => message.role === 'user')
    .map((message) => message.text)

/** A model turn that keeps the agent busy for ~`ms` while streaming text. */
const slowText = (text, ms) =>
  turn.text(text, { chunkSize: 1, delayMs: Math.max(5, Math.round(ms / text.length)) })

async function queueWhileRunning(app, text, { followUp = false } = {}) {
  const box = composer(app)
  await box.fill(text)
  await box.press(followUp ? 'Alt+Enter' : 'Enter')
  const kind = followUp ? 'followUp' : 'steering'
  await until(async () => (await app.agentState()).queue[kind].includes(text), {
    label: `"${text}" in the ${kind} queue`
  })
}

async function setQueueMode(app, label, option) {
  await app.page.keyboard.press('Control+,')
  await app.page.getByText('Agent behavior', { exact: true }).first().click()
  const title = app.page.getByText(label, { exact: true })
  await title.waitFor()
  const row = title.locator('xpath=ancestor::*[.//*[@role="radiogroup"]][1]')
  await row.getByRole('radio', { name: option }).click()
  await sleep(400)
  await app.page.keyboard.press('Escape')
  await sleep(200)
}

await runSuite(
  'chat-queue',
  async ({ server, app, agentDir, step }) => {
    const checks = softSteps(step, app)

    await step('open on qa-reasoning', async () => {
      await app.openWorkspace({
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, thinking: 'off' }
      })
    })

    await step('Stop during streaming aborts the request and keeps the partial text', async () => {
      const from = server.requests.length
      server.queue(turn.hang({ text: 'partial answer before stop' }))
      await app.send('Stream then stop')
      const request = await server.waitForRequest(undefined, { from })
      await app.page.getByText('partial answer before stop').waitFor()
      await app.page.getByRole('button', { name: 'Stop', exact: true }).click()
      assert.equal(await server.waitForOutcome(request), 'aborted')
      await app.waitForSettle()
      const state = await app.agentState()
      const last = state.entries.at(-1).message
      assert.equal(last.role, 'assistant')
      assert.equal(last.stopReason, 'aborted')
      await app.page.getByText('partial answer before stop').waitFor()
      await app.screenshot('stop-during-streaming')
      assert.equal(server.requests.length - from, 1, 'no retry after a user abort')
    })

    await step('Esc Esc stops a streaming run', async () => {
      const from = server.requests.length
      server.queue(turn.hang({ text: 'escape me' }))
      await app.send('Stream then escape')
      const request = await server.waitForRequest(undefined, { from })
      await app.page.getByText('escape me').waitFor()
      await composer(app).press('Escape')
      await app.page.getByText(/Press.*again to stop/).waitFor()
      await composer(app).press('Escape')
      assert.equal(await server.waitForOutcome(request), 'aborted')
      await app.waitForSettle()
    })

    await step('Stop during a running bash tool kills it quickly', async () => {
      const from = server.requests.length
      server.queue(
        turn.toolCalls([{ id: 'toolu_sleep', name: 'bash', args: { command: 'sleep 30' } }])
      )
      await app.send('Run a long command')
      await until(async () => (await app.agentState()).tools.toolu_sleep?.status === 'running', {
        label: 'bash running'
      })
      await sleep(500)
      const stoppedAt = Date.now()
      await app.page.getByRole('button', { name: 'Stop', exact: true }).click()
      await app.waitForSettle({ timeoutMs: 15_000 })
      assert.ok(Date.now() - stoppedAt < 10_000, 'the 30 s sleep did not run to the end')
      const tool = (await app.agentState()).tools.toolu_sleep
      assert.equal(tool.status, 'error', 'aborted tool ends as error/interrupted')
      assert.equal(server.requests.length - from, 1, 'no follow-up request after the abort')
      await app.screenshot('stop-during-tool')
    })

    await checks.check(
      'a user Stop during a tool reads as "Stopped", not as an error',
      async () => {
        // The engine ends the run with stopReason "error" + "This operation was aborted".
        const card = app.page.getByText('This operation was aborted')
        assert.equal(await card.count(), 0, 'no "This operation was aborted" error card')
      }
    )

    await step(
      'steer (Enter) while a tool runs: delivered right after the tool result',
      async () => {
        const from = server.requests.length
        server.queue(
          turn.toolCalls([{ id: 'toolu_steer', name: 'bash', args: { command: 'sleep 2' } }]),
          turn.text('Adjusted after steering.')
        )
        await app.send('Start something')
        await until(async () => (await app.agentState()).tools.toolu_steer?.status === 'running', {
          label: 'tool running'
        })
        await queueWhileRunning(app, 'steer: use plan B')
        await app.page.getByText('steer: use plan B').waitFor()
        await app.screenshot('steer-queued-chip')
        await app.waitForSettle()
        const second = server.requests[from + 1]
        assert.ok(second, 'a second request')
        const sent = inspectRequest(second)
        assert.ok(
          sent.toolResults.some((r) => r.toolCallId === 'toolu_steer'),
          'tool result first'
        )
        assert.equal(sent.lastUserText, 'steer: use plan B', 'steering message in the next request')
        assert.equal(server.requests.length - from, 2)
      }
    )

    await step('follow-up (Alt+Enter) waits for the turn to finish, then runs', async () => {
      const from = server.requests.length
      server.queue(slowText('A slow answer that streams for a while.', 2000))
      await app.send('Answer slowly')
      await queueWhileRunning(app, 'follow-up: and then?', { followUp: true })
      await app.page.getByText('follow-up: and then?').waitFor()
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 2, 'the follow-up made a second request')
      const second = server.requests[from + 1]
      assert.deepEqual(userTexts(second).slice(-2), ['Answer slowly', 'follow-up: and then?'])
    })

    await step('steeringMode one-at-a-time (default): one steering message per turn', async () => {
      const engine = await app.rpc({ type: 'get_state' })
      assert.equal(engine.steeringMode, 'one-at-a-time')
      const from = server.requests.length
      server.queue(
        turn.toolCalls([{ id: 'toolu_one', name: 'bash', args: { command: 'sleep 2' } }]),
        turn.text('after first steer'),
        turn.text('after second steer')
      )
      await app.send('Steer twice, one at a time')
      await until(async () => (await app.agentState()).tools.toolu_one?.status === 'running', {
        label: 'tool running'
      })
      await queueWhileRunning(app, 'steer one A')
      await queueWhileRunning(app, 'steer one B')
      await app.waitForSettle()
      const requests = server.requests.slice(from)
      assert.equal(requests.length, 3, 'tool call, then one request per steering message')
      assert.equal(inspectRequest(requests[1]).lastUserText, 'steer one A')
      assert.ok(!userTexts(requests[1]).includes('steer one B'), 'B not delivered with A')
      assert.equal(inspectRequest(requests[2]).lastUserText, 'steer one B')
    })

    await step('Settings → Steering delivery "All at once" reaches the engine', async () => {
      await setQueueMode(app, 'Steering delivery', 'All at once')
      await until(async () => (await app.rpc({ type: 'get_state' })).steeringMode === 'all', {
        label: 'engine steeringMode all'
      })
      assert.equal((await agentDir.readJson('settings.json')).steeringMode, 'all')
    })

    await step('steeringMode all: both steering messages in one request', async () => {
      const from = server.requests.length
      server.queue(
        turn.toolCalls([{ id: 'toolu_all', name: 'bash', args: { command: 'sleep 2' } }]),
        turn.text('after both steers')
      )
      await app.send('Steer twice, all at once')
      await until(async () => (await app.agentState()).tools.toolu_all?.status === 'running', {
        label: 'tool running'
      })
      await queueWhileRunning(app, 'steer all A')
      await queueWhileRunning(app, 'steer all B')
      await app.waitForSettle()
      const requests = server.requests.slice(from)
      assert.equal(requests.length, 2, 'both delivered together')
      assert.deepEqual(userTexts(requests[1]).slice(-2), ['steer all A', 'steer all B'])
    })

    await step('followUpMode one-at-a-time: one follow-up per run', async () => {
      const from = server.requests.length
      server.queue(slowText('Busy streaming for follow-ups.', 2000))
      await app.send('Follow-ups one at a time')
      await queueWhileRunning(app, 'follow one A', { followUp: true })
      await queueWhileRunning(app, 'follow one B', { followUp: true })
      await app.waitForSettle()
      const requests = server.requests.slice(from)
      assert.equal(requests.length, 3)
      assert.equal(inspectRequest(requests[1]).lastUserText, 'follow one A')
      assert.equal(inspectRequest(requests[2]).lastUserText, 'follow one B')
    })

    await step('Settings → Follow-up delivery "All at once": both in one request', async () => {
      await setQueueMode(app, 'Follow-up delivery', 'All at once')
      await until(async () => (await app.rpc({ type: 'get_state' })).followUpMode === 'all', {
        label: 'engine followUpMode all'
      })
      const from = server.requests.length
      server.queue(slowText('Busy streaming for follow-ups again.', 2000))
      await app.send('Follow-ups all at once')
      await queueWhileRunning(app, 'follow all A', { followUp: true })
      await queueWhileRunning(app, 'follow all B', { followUp: true })
      await app.waitForSettle()
      const requests = server.requests.slice(from)
      assert.equal(requests.length, 2)
      assert.deepEqual(userTexts(requests[1]).slice(-2), ['follow all A', 'follow all B'])
    })

    await step('queue chip ✕ removes one queued message; only the other is sent', async () => {
      const from = server.requests.length
      server.queue(slowText('Streaming while the queue is edited.', 3000))
      await app.send('Edit the queue')
      await queueWhileRunning(app, 'keep me', { followUp: true })
      await queueWhileRunning(app, 'drop me', { followUp: true })
      const chip = app.page.locator('span', { hasText: /^Follow-updrop me$/ })
      await chip.getByRole('button', { name: 'Remove queued message' }).click()
      await until(
        async () => {
          const queue = (await app.agentState()).queue.followUp
          return queue.length === 1 && queue[0] === 'keep me'
        },
        { label: 'queue = [keep me]' }
      )
      await app.waitForSettle()
      const texts = server.requests.slice(from).flatMap(userTexts)
      assert.ok(texts.includes('keep me'), 'kept message sent')
      assert.ok(!texts.includes('drop me'), 'removed message never sent')
    })

    await step('"Edit queue" (Alt+Up) moves queued messages back into the editor', async () => {
      const from = server.requests.length
      server.queue(slowText('Streaming while restoring the queue.', 2500))
      await app.send('Restore the queue')
      await queueWhileRunning(app, 'restore me', { followUp: true })
      await app.page.getByRole('button', { name: 'Edit queue' }).click()
      await until(async () => (await composer(app).inputValue()) === 'restore me', {
        label: 'editor holds the queued text'
      })
      assert.deepEqual((await app.agentState()).queue.followUp, [])
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 1, 'restored message not sent')
      await composer(app).fill('')
    })

    await step('Stop with a queued follow-up restores it into the editor', async () => {
      const from = server.requests.length
      server.queue(turn.hang({ text: 'hanging with a queue' }))
      await app.send('Hang with a queue')
      await app.page.getByText('hanging with a queue').waitFor()
      await queueWhileRunning(app, 'queued before stop', { followUp: true })
      await app.page.getByRole('button', { name: 'Stop', exact: true }).click()
      await app.waitForSettle()
      assert.equal(await composer(app).inputValue(), 'queued before stop')
      assert.equal(server.requests.length - from, 1)
      await composer(app).fill('')
    })

    await checks.check('no app errors', async () => app.assertNoErrors())
    checks.assertAll()
  },
  { launch: { outDir: SHOTS_DIR } }
)
