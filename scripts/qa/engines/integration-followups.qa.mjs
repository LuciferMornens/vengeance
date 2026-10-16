import { performance } from 'node:perf_hooks'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'
import { checkNativeSubagents } from './integration-native-controls.mjs'
import { checkResidentReattach } from './integration-session-lifecycle.mjs'

const SUITE_NAME = 'engines-followups'
const PI_SESSION_NAME = 'Engine isolation session'
const PRIME_SESSION_NAME = 'Engine2 integration session'
const HISTORY_TEXT = 'Engine2 streamed reply.'
const RECONNECT_ONLY = process.argv.includes('--reconnect-only')
const CHILDREN_ONLY = process.argv.includes('--children-only')

if (RECONNECT_ONLY && CHILDREN_ONLY) {
  throw new Error('Choose either --reconnect-only or --children-only.')
}

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  const elapsedSeconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`    ✓ ${label} (${elapsedSeconds}s)`)
  return result
}

console.log(`▶ ${SUITE_NAME} (native Engine2 and local fake providers)`)
const fixture = await createEngineFixture()
let application
let failure
const checks = softSteps(step, { app: () => application, name: SUITE_NAME })

try {
  const workspace = await fixture.root.folder('workspace')
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: reportShotsDir('engines')
  })
  await step('create saved Engine history for startup restoration', async () => {
    await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'pi',
        provider: FAKE_PROVIDER,
        model: FAKE_MODELS.reasoning,
        name: PI_SESSION_NAME
      }
    })
    fixture.piServer.queue(turn.text('Engine history survives the native follow-up checks.'))
    await application.send('Reply briefly for the saved Engine restoration probe')
    await application.waitForSettle()
  })
  const prime = await step('create saved Engine2 history through the native provider', async () => {
    const agent = await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off',
        name: PRIME_SESSION_NAME
      }
    })
    fixture.primeServer.queue(turn.text(HISTORY_TEXT))
    await application.send('Reply briefly for the native saved history probe')
    await application.waitForSettle()
    return agent
  })
  const state = await application.rpc({ type: 'get_state' }, prime.agentId)
  if (!RECONNECT_ONLY) {
    await checkNativeSubagents(application, fixture.primeServer, prime.agentId, checks.check)
  }
  if (!CHILDREN_ONLY) {
    await checkResidentReattach(
      application,
      fixture.primeServer,
      {
        agentId: prime.agentId,
        name: PRIME_SESSION_NAME,
        sessionFile: state.sessionFile,
        historyText: HISTORY_TEXT,
        onRelaunch: (nextApplication) => {
          application = nextApplication
        }
      },
      checks.check
    )
  }
  await checks.check('no uncaught app errors in native follow-ups', async () => {
    application.assertNoErrors()
  })
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
  console.error(`✗ ${SUITE_NAME} failed`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE_NAME} passed`)
}
