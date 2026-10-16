import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchApp, reportShotsDir, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

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
const OUTPUT_DIRECTORY = process.env.QA_PRIME_EXECUTABLE
  ? join(
      process.env.QA_REPORT_DIR
        ? resolve(process.env.QA_REPORT_DIR)
        : join(ROOT, '.shots', 'qa', 'native-prime-candidate'),
      'bash-queue'
    )
  : reportShotsDir('engines')

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
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
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
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
      // This isolated probe intentionally resets the runtime; production shell runs must not do this.
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
      const removeChip = async (text) => {
        const chip = application.page
          .locator('span')
          .filter({ hasText: text })
          .filter({ has: application.page.getByRole('button', { name: 'Remove queued message' }) })
        await chip.last().getByRole('button', { name: 'Remove queued message' }).click()
      }
      await removeChip(PLAIN_MESSAGE)
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
      await removeChip(SECOND_INJECTED)
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
