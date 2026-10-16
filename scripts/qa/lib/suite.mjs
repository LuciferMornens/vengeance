// One QA suite = one script that calls runSuite(). It owns the fake LLM, the temp engine config and
// the app for the suite's lifetime, prints each step, and sets the process exit code.
import { performance } from 'node:perf_hooks'
import { createAgentDir } from './agent-dir.mjs'
import { launchApp } from './app.mjs'
import { describeRequest, startFakeLlm } from './fake-llm.mjs'

/** Requests printed (redacted) when a suite fails. */
const FAILURE_REQUEST_COUNT = 3

function seconds(since) {
  return `${((performance.now() - since) / 1000).toFixed(1)}s`
}

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${seconds(started)})`)
  return result
}

/**
 * @param {string} name suite name (also the failure screenshot name)
 * @param {(context: { server, agentDir, app, step }) => Promise<void>} body the suite;
 *   `server` and `agentDir` are null in REAL mode
 * @param {object} [options]
 * @param {'fake' | 'real'} [options.mode]
 * @param {object} [options.agentDir] createAgentDir() options besides `server`
 * @param {object} [options.launch] launchApp() options besides `mode` and `agentDir`
 */
export async function runSuite(
  name,
  body,
  { mode = 'fake', agentDir: agentDirOptions = {}, launch = {} } = {}
) {
  const started = performance.now()
  console.log(`▶ ${name} (${mode})`)
  let server = null
  let agentDir = null
  let app = null
  const failures = []
  try {
    if (mode === 'fake') {
      server = await startFakeLlm()
      agentDir = await createAgentDir({ server, ...agentDirOptions })
    }
    app = await launchApp({ ...launch, mode, agentDir: agentDir?.dir })
    await body({ server, agentDir, app, step })
  } catch (error) {
    failures.push(error)
    await app?.screenshot(`${name}-FAILED`, { settleMs: 0 }).catch(() => undefined)
    if (server?.requests.length) {
      const recent = server.requests.slice(-FAILURE_REQUEST_COUNT).map((request) => {
        const { index, api, path, outcome, headers } = describeRequest(request)
        return { index, api, path, outcome, headers }
      })
      console.error(`  last model requests: ${JSON.stringify(recent, null, 2)}`)
    }
  } finally {
    await app?.close().catch((error) => failures.push(error))
    await server?.close().catch((error) => failures.push(error))
    await agentDir?.cleanup().catch((error) => failures.push(error))
  }
  if (failures.length) {
    for (const failure of failures) console.error(`  ✗ ${failure.stack ?? failure}`)
    console.error(`✗ ${name} failed (${seconds(started)})`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${name} passed (${seconds(started)})`)
  }
}
