import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { launchApp, reportShotsDir, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'
import { packagedLaunchOptions, recordPackagedTarget } from '../lib/packaged-target.mjs'

const SUITE_NAME = 'prime-bash-queue'
const WAIT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 50
const INCLUDED_MARKER = 'qa-shell-included-7c981'
const EXCLUDED_MARKER = 'qa-shell-excluded-a612f'
const CANCELLED_MARKER = 'qa-shell-cancelled-82db4'
const CONTEXT_PROMPT = 'Reply briefly for the shell context check'
const REOPEN_CONTEXT_PROMPT = 'Reply briefly after the native shell history reload'
const QUEUE_PROMPT = 'Hold this turn for the queue mutation check'
const PLAIN_MESSAGE = 'Remove this plain follow-up'
const FIRST_INJECTED = 'Keep the first native delivery metadata'
const SECOND_INJECTED = 'Remove this labeled native delivery'
const REMOVE_QUEUED = 'Remove queued message'
const SETTLED_FRAMES = 4
const CLICK_EFFECT_MS = 2_500
const OUTPUT_DIRECTORY = process.env.QA_PRIME_EXECUTABLE
  ? join(
      process.env.QA_REPORT_DIR
        ? resolve(process.env.QA_REPORT_DIR)
        : join(ROOT, '.shots', 'qa', 'native-prime-candidate'),
      'bash-queue'
    )
  : reportShotsDir('engines')

async function poll(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  return undefined
}

async function until(predicate, label) {
  const result = await poll(predicate, WAIT_TIMEOUT_MS)
  if (!result) throw new Error(`Timed out waiting for ${label}`)
  return result
}

async function step(label, action) {
  console.log(`  • ${label}`)
  await action()
  console.log(`    ✓ ${label}`)
}

console.log(`▶ ${SUITE_NAME} (isolated native Engine 2 and local provider)`)
const fixture = await createEngineFixture()
let application
let failure
const checks = softSteps(step, { app: () => application, name: SUITE_NAME })

try {
  application = await launchApp({
    ...packagedLaunchOptions(fixture.environment),
    agentDir: fixture.piDirectory.dir,
    outDir: OUTPUT_DIRECTORY
  })
  await recordPackagedTarget(application)
  const { agentId } = await application.openWorkspace({
    cwd: await fixture.root.folder('workspace'),
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: 'Native shell and queue checks'
    }
  })
  if (fixture.candidate) {
    await until(
      async () => (await application.agentState(agentId)).status === 'ready',
      'reviewed native candidate ready'
    )
    const identity = await fixture.verifyPrimeExecutable(application, agentId)
    await mkdir(OUTPUT_DIRECTORY, { recursive: true })
    await writeFile(
      join(OUTPUT_DIRECTORY, 'candidate-identity.json'),
      JSON.stringify(identity, null, 2)
    )
    console.log(`    Native candidate SHA-256 ${identity.sha256}`)
  }
  const native = (command, payload = {}) =>
    application.invoke('prime:command', agentId, command, payload)
  const composer = application.page.getByRole('textbox', { name: 'Message', exact: true })
  const submitBash = async (command, excluded) => {
    await composer.fill(`${excluded ? '!!' : '!'}${command}`)
    await composer.press('Enter')
  }
  const landedBash = (command) =>
    until(async () => {
      const state = await application.agentState(agentId)
      return state.entries.findLast(
        (entry) => entry.message.role === 'bashExecution' && entry.message.command === command
      )?.message
    }, `completed shell transcript for ${command}`)

  await checks.check(
    '! and !! stream, persist once, and honor model-context exclusion',
    async () => {
      for (const [marker, excluded] of [
        [INCLUDED_MARKER, false],
        [EXCLUDED_MARKER, true]
      ]) {
        const command = `printf '${marker}\\n'; sleep 2; printf 'finished\\n'`
        await submitBash(command, excluded)
        await until(async () => {
          const state = await application.agentState(agentId)
          return Object.values(state.bash).some(
            (run) => run.command === command && run.running && run.output.includes(marker)
          )
        }, 'shell output before command completion')
        await application.screenshot(`${SUITE_NAME}-${excluded ? 'excluded' : 'included'}-stream`)
        const message = await landedBash(command)
        assert.equal(message.exitCode, 0)
        assert.equal(message.cancelled, false)
        assert.equal(message.excludeFromContext === true, excluded)
        assert.equal(message.output, `${marker}\nfinished\n`)
        const history = await native('get_messages')
        const matches = history.messages.filter(
          (entry) => entry.role === 'bashExecution' && entry.command === command
        )
        assert.equal(matches.length, 1)
        assert.equal(matches[0].excludeFromContext === true, excluded)
        const state = await application.rpc({ type: 'get_state' }, agentId)
        const saved = (await readFile(state.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse)
        const savedBash = saved.filter((entry) => entry.message?.command === command)
        assert.equal(savedBash.length, 1, 'native history records the command once')
        assert.equal(savedBash[0].message.excludeFromContext === true, excluded)
      }
      fixture.primeServer.queue(turn.text('Shell context verified.'))
      const requestFrom = fixture.primeServer.requests.length
      await application.send(CONTEXT_PROMPT)
      await application.waitForSettle()
      const request = await fixture.primeServer.waitForRequest(
        (entry) => inspectRequest(entry).lastUserText.includes(CONTEXT_PROMPT),
        { from: requestFrom }
      )
      const modelContext = JSON.stringify(request.body)
      await writeFile(
        join(OUTPUT_DIRECTORY, `${SUITE_NAME}-context.json`),
        JSON.stringify({ request: request.body, history: await native('get_messages') }, null, 2)
      )
      assert.ok(modelContext.includes(INCLUDED_MARKER), 'ordinary shell output reaches the model')
      assert.ok(
        !modelContext.includes(EXCLUDED_MARKER),
        '!! command and output stay out of model context'
      )
    }
  )

  await checks.check(
    'explicit native reopen projects included shell history and excludes !!',
    async () => {
      // Native reopen is explicit here; interactive shell runs keep their runtime.
      const state = await application.rpc({ type: 'get_state' }, agentId)
      await application.rpc({ type: 'switch_session', sessionPath: state.sessionFile }, agentId)
      fixture.primeServer.queue(turn.text('Native shell history reload checked.'))
      const requestFrom = fixture.primeServer.requests.length
      await application.send(REOPEN_CONTEXT_PROMPT)
      await application.waitForSettle()
      const request = await fixture.primeServer.waitForRequest(
        (entry) => inspectRequest(entry).lastUserText.includes(REOPEN_CONTEXT_PROMPT),
        { from: requestFrom }
      )
      await writeFile(
        join(OUTPUT_DIRECTORY, `${SUITE_NAME}-reopened-context.json`),
        JSON.stringify({ request: request.body, history: await native('get_messages') }, null, 2)
      )
      const modelContext = JSON.stringify(request.body)
      assert.ok(
        modelContext.includes(INCLUDED_MARKER),
        'native reopen projects ! output to the model'
      )
      assert.ok(
        !modelContext.includes(EXCLUDED_MARKER),
        'native reopen keeps !! out of model context'
      )
    }
  )

  await checks.check('shell cancellation settles the composer and durable history', async () => {
    const command = `printf '${CANCELLED_MARKER}\\n'; sleep 20`
    await submitBash(command, true)
    await until(
      async () =>
        Object.values((await application.agentState(agentId)).bash).some(
          (run) => run.running && run.output.includes(CANCELLED_MARKER)
        ),
      'cancellable output'
    )
    await application.rpc({ type: 'abort_bash' }, agentId)
    const message = await landedBash(command)
    assert.equal(message.cancelled, true)
    assert.equal(message.excludeFromContext, true)
    assert.ok(
      !Object.values((await application.agentState(agentId)).bash).some((run) => run.running)
    )
    const history = await native('get_messages')
    assert.equal(history.messages.findLast((entry) => entry.command === command).cancelled, true)
    await application.screenshot(`${SUITE_NAME}-cancelled`)
  })

  await checks.check(
    'queue deletion preserves neighboring native deliveries and handles labeled previews',
    async () => {
      fixture.primeServer.queue(turn.hang({ text: 'Holding the queue mutation probe.' }))
      await application.send(QUEUE_PROMPT)
      await application.rpc({ type: 'follow_up', message: PLAIN_MESSAGE }, agentId)
      const state = await native('get_state')
      for (const message of [FIRST_INJECTED, SECOND_INJECTED]) {
        await native('send_message', {
          targetActiveSessionId: state.activeSessionId,
          message,
          deliveryMode: 'follow_up'
        })
      }
      const queue = await native('get_queue')
      assert.equal(queue.followUp.length, 3)
      const removeButtons = application.page.getByRole('button', { name: REMOVE_QUEUED })
      const queueToast = application.page.locator('[data-toaster] [role="alert"]', {
        hasText: 'Could not update the queue'
      })
      // Native replies can precede queue rendering; exiting chips keep stale removal handlers.
      // The strip opens with a height spring inside the bottom-anchored composer, so its chips move
      // until it rests. A press and release on different elements make Chromium click their common
      // ancestor: Playwright reports success and the chip's handler never runs.
      const waitForSettledQueue = (previews) =>
        until(async () => {
          if ((await removeButtons.count()) !== previews.length) return false
          const counts = await Promise.all(
            previews.map((preview) => application.page.getByText(preview, { exact: true }).count())
          )
          if (!counts.every((count) => count === 1)) return false
          return application.page.evaluate(
            async ({ label, frames }) => {
              const boxes = () =>
                [...document.querySelectorAll(`button[aria-label="${label}"]`)]
                  .map((button) => {
                    let clip = button.parentElement
                    while (clip && getComputedStyle(clip).overflow === 'visible') {
                      clip = clip.parentElement
                    }
                    const box = button.getBoundingClientRect()
                    const strip = (clip ?? document.documentElement).getBoundingClientRect()
                    const inside =
                      box.top >= strip.top &&
                      box.bottom <= strip.bottom &&
                      box.left >= strip.left &&
                      box.right <= strip.right
                    return inside ? `${box.x},${box.y},${box.width},${box.height}` : 'clipped'
                  })
                  .join(' ')
              const first = boxes()
              for (let frame = 0; frame < frames; frame++) {
                await new Promise(requestAnimationFrame)
                if (boxes() !== first) return false
              }
              return !first.includes('clipped')
            },
            { label: REMOVE_QUEUED, frames: SETTLED_FRAMES }
          )
        }, 'settled native queue previews')
      // Records where each press, release and click landed, so a click that never reached the
      // button (nothing was sent, safe to repeat) is told apart from a request still under way.
      const tracedClick = async (button) => {
        const trace = await button.evaluateHandle((target) => {
          const events = []
          const record = (event) => {
            const label = event.target.getAttribute?.('aria-label')
            const box = target.getBoundingClientRect()
            events.push({
              type: event.type,
              onButton: target.contains(event.target),
              element: `${event.target.tagName?.toLowerCase()}${label ? `[${label}]` : ''}`,
              point: `${Math.round(event.clientX)},${Math.round(event.clientY)}`,
              button: `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`
            })
          }
          const types = ['pointerdown', 'pointerup', 'click']
          for (const type of types) window.addEventListener(type, record, true)
          const stop = () => {
            for (const type of types) window.removeEventListener(type, record, true)
          }
          return { events, stop }
        })
        try {
          await button.click()
          return await trace.evaluate(({ events, stop }) => {
            stop()
            return events
          })
        } finally {
          await trace.dispose()
        }
      }
      const removeChip = async (text, previews) => {
        const before = (await native('get_queue')).followUp
        const button = application.page
          .locator('span')
          .filter({ hasText: text })
          .filter({ has: removeButtons })
          .getByRole('button', { name: REMOVE_QUEUED })
        for (let attempt = 1; ; attempt++) {
          await waitForSettledQueue(previews)
          const events = await tracedClick(button)
          const effect = await poll(async () => {
            if (await queueToast.count()) return { refused: await queueToast.first().innerText() }
            const now = (await native('get_queue')).followUp
            return !isDeepStrictEqual(now, before) && { applied: true }
          }, CLICK_EFFECT_MS)
          if (effect?.refused) {
            throw new Error(
              `Removing "${text}" was refused: ${effect.refused.replace(/\s+/g, ' ')}`
            )
          }
          if (effect?.applied) return
          if (events.some((event) => event.type === 'click' && event.onButton)) {
            console.log(`    … "${text}" was clicked; native unchanged after ${CLICK_EFFECT_MS} ms`)
            return
          }
          const landed = events
            .map(
              (event) =>
                `${event.type} at ${event.point} on ${event.onButton ? 'the button' : event.element}` +
                ` (button at ${event.button})`
            )
            .join('; ')
          if (attempt > 1) throw new Error(`Clicks on "${text}" never reached it: ${landed}`)
          const unchanged =
            (await button.count()) === 1 &&
            (await queueToast.count()) === 0 &&
            isDeepStrictEqual((await native('get_queue')).followUp, before)
          if (!unchanged) return
          console.log(`    ↻ the click on "${text}" missed (${landed}); clicking once more`)
        }
      }
      await removeChip(PLAIN_MESSAGE, queue.followUp)
      await until(
        async () => (await native('get_queue')).followUp.length === 2,
        'single atomic deletion'
      )
      const remaining = await native('get_queue')
      assert.deepEqual(remaining.followUp, queue.followUp.slice(1))
      const rejected = await native('mutate_queued_message', {
        lane: 'followUp',
        index: 0,
        expectedText: remaining.followUp[0],
        mutation: { type: 'replace', text: 'must not replace injected metadata' }
      })
      assert.equal(
        rejected.status,
        'rejected',
        'the neighboring row still owns native injected metadata'
      )
      const stale = await native('mutate_queued_message', {
        lane: 'followUp',
        index: 0,
        expectedText: 'outdated preview',
        mutation: { type: 'delete' }
      })
      assert.equal(stale.status, 'rejected')
      assert.deepEqual((await native('get_queue')).followUp, remaining.followUp)
      await removeChip(SECOND_INJECTED, remaining.followUp)
      await until(
        async () => (await native('get_queue')).followUp.length === 1,
        'labeled preview deletion'
      )
      assert.deepEqual((await native('get_queue')).followUp, [remaining.followUp[0]])
      await application.screenshot(`${SUITE_NAME}-native-queue`)
      await application.rpc({ type: 'clear_queue' }, agentId)
      await application.rpc({ type: 'abort' }, agentId)
      await application.waitForSettle()
    }
  )
  application.assertNoErrors()
  checks.finish()
} catch (error) {
  failure = error
  await application?.screenshot(`${SUITE_NAME}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
}

if (failure) {
  console.error(`  ✗ ${failure.stack ?? failure}`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE_NAME} passed`)
}
