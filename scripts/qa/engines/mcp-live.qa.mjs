// Engine 2 live MCP status against the real native engine (Vengeance patch 0024): the stdio QA
// fixture server declared in the temporary Engine 2 account's `mcpServers` shows in the composer MCP
// chip as configured-only while the conversation has no running kernel, connects with its tool
// count once the kernel runs, comes back connected from Reconnect (a new server process), shows the
// same live state in Settings → MCP, and a second conversation's own kernel reports it by itself.
// That conversation also runs a fixture server that never answers: it reads as failed with the
// reason, stays failed while the panel keeps asking, and keeps a Reconnect that tries it again.
//
//   node scripts/qa/engines/mcp-live.qa.mjs
//
// Needs uv on PATH and network for the first kernel bootstrap (see scripts/qa/README.md).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest } from '../lib/fake-llm.mjs'
import { captureFailedNativeDiagnostics } from '../lib/native-diagnostics.mjs'
import { nativeKernelCode, runNativePythonProbe } from '../lib/native-kernel.mjs'
import { packagedLaunchOptions } from '../lib/packaged-target.mjs'
import { FIXTURES_DIR } from '../ext/lib/ext-helpers.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const SUITE_NAME = 'engines-mcp-live'
const SERVER_NAME = 'qa-mcp'
const HUNG_SERVER = 'qa-mcp-hung'
const STALLED_TEXT = 'Did not answer within 10 s; Reconnect gives it 20 s.'
const SERVER_SCRIPT = join(FIXTURES_DIR, 'qa-mcp-server.mjs')
const FIXTURE_TOOL_COUNT = 3
const WAIT_TIMEOUT_MS = 60_000
const KERNEL_BOOTSTRAP_TIMEOUT_MS = 180_000
/** Enough for the open panel to read again: 5 s apart, each waiting 10 s on the hung server. */
const STALLED_WATCH_MS = 20_000
/** Reconnect of the hung server: 20 s in the reconnect, then 10 s in the read after it. */
const HUNG_RECONNECT_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 100
const NOT_LIVE_TEXT =
  'Engine 2 opens these servers once this conversation’s Python runtime starts. ' +
  'Until then, their states come from your MCP settings.'
const FIRST_SESSION = 'Engine2 MCP live session'
const SECOND_SESSION = 'Engine2 MCP second session'

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

async function until(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

console.log(`▶ ${SUITE_NAME} (native Engine2, local fake provider, stdio MCP fixture)`)
const started = performance.now()
const fixture = await createEngineFixture()
let application
let failure

try {
  const countStarts = (log) =>
    existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
  const startLog = fixture.root.path('qa-mcp-starts.log')
  const hungLog = fixture.root.path('qa-mcp-hung-starts.log')
  const starts = () => countStarts(startLog)
  const hungStarts = () => countStarts(hungLog)
  // The kernel starts its servers with a cleared environment, so the start log is an argument.
  const settingsPath = join(fixture.primeDirectory, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  settings.mcpServers = {
    [SERVER_NAME]: {
      type: 'stdio',
      command: process.execPath,
      args: [SERVER_SCRIPT, `--log=${startLog}`],
      enabled: true
    }
  }
  await writeFile(settingsPath, JSON.stringify(settings, null, 2))
  // Engine 2 prewarms the kernel when a conversation starts. A file where the kernel venv's parent
  // folder belongs makes that first start fail (a failed start is retried on next use), so the
  // conversation deterministically has no running kernel until the gate is removed.
  const kernelGate = fixture.root.path('kernel-gate')
  await writeFile(kernelGate, 'Holds the kernel venv until the not-live check ran.\n')
  const workspace = await fixture.root.folder('workspace', {
    'README.md': '# Engine 2 MCP workspace\nOnly isolated QA files live here.\n'
  })
  application = await launchApp({
    ...packagedLaunchOptions({
      ...fixture.environment,
      PRIME_AGENT_KERNEL_VENV: join(kernelGate, 'kernel-venv'),
      PYTHONPYCACHEPREFIX: fixture.root.path('pycache')
    }),
    agentDir: fixture.piDirectory.dir,
    outDir: reportShotsDir('engines')
  })
  const { page } = application
  // Each open conversation's composer has its own chip; only the active one is visible.
  const chip = page.locator('[data-mcp-chip]').filter({ visible: true })
  const panel = page.locator('[data-mcp-panel]')
  const serverRow = panel.locator(`[data-mcp-server="${SERVER_NAME}"]`)
  const connectedRow = panel.locator(
    `[data-mcp-server="${SERVER_NAME}"][data-mcp-state="connected"]`
  )
  const openPanel = async () => {
    if (await panel.isVisible()) return
    await chip.click()
    await panel.waitFor()
  }
  const closePanel = async () => {
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
  }
  let agentId

  await step('open an Engine 2 conversation with the stdio server configured', async () => {
    const opened = await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off',
        name: FIRST_SESSION
      }
    })
    agentId = opened.agentId
    const prime = (await application.invoke('engine:list')).find(
      (agent) => agent.agentId === agentId
    )
    assert.equal(prime?.engine, 'prime')
  })

  await step('without a running kernel the chip panel says its states are not live', async () => {
    await chip.waitFor({ timeout: WAIT_TIMEOUT_MS })
    assert.match(await chip.getAttribute('aria-label'), /MCP servers: 1, not started yet/)
    assert.match(await chip.innerText(), /MCP\s*· not started/)
    await openPanel()
    await panel.getByText(NOT_LIVE_TEXT, { exact: true }).waitFor()
    await serverRow.waitFor()
    assert.equal(await serverRow.getAttribute('data-mcp-state'), 'idle')
    assert.match(await serverRow.innerText(), /Not started yet/)
    // Without a kernel there is no connection to reconnect: the row offers none.
    assert.equal(
      await serverRow
        .getByRole('button', { name: `Reconnect ${SERVER_NAME}`, exact: true })
        .count(),
      0
    )
    // The status lane never boots a kernel: the panel's reads leave the server unstarted.
    assert.equal(starts(), 0, 'no server process before the kernel runs')
    const status = await application.invoke('engine:bridge', agentId, { op: 'mcp' }, undefined)
    assert.equal(status.source, 'prime')
    assert.equal(status.live, false)
    await application.screenshot('engine2-mcp-not-live')
    await closePanel()
  })

  await step('the kernel runs a Python tool call once its venv can be created', async () => {
    await rm(kernelGate)
    const toolCallId = 'engine2-mcp-kernel'
    const { result, firstRequest } = await runNativePythonProbe(
      application,
      fixture.primeServer,
      agentId,
      {
        toolCallId,
        toolName: 'ipython',
        code: nativeKernelCode('print("Engine2 MCP kernel up")'),
        prompt: 'Start the kernel for the MCP probe',
        timeoutMs: KERNEL_BOOTSTRAP_TIMEOUT_MS
      }
    )
    assert.ok(inspectRequest(firstRequest).tools.includes('ipython'), 'ipython is declared')
    assert.notEqual(result.isError, true, result.text)
    assert.ok(result.text.includes('Engine2 MCP kernel up'), result.text)
  })

  await step(
    'with the kernel running the server reports connected live with its tools',
    async () => {
      // The end of the turn asks again: the closed chip follows the kernel by itself.
      await until(
        async () =>
          /MCP servers: 1 of 1 connected/.test((await chip.getAttribute('aria-label')) ?? ''),
        'the closed chip to report the server connected'
      )
      await openPanel()
      // The panel asks Engine 2 again every few seconds while it is open.
      await connectedRow.waitFor({ timeout: WAIT_TIMEOUT_MS })
      assert.equal(await panel.getByText(NOT_LIVE_TEXT, { exact: true }).count(), 0)
      assert.match(
        await serverRow.innerText(),
        new RegExp(`Connected · ${FIXTURE_TOOL_COUNT} tools`)
      )
      assert.match(await chip.getAttribute('aria-label'), /MCP servers: 1 of 1 connected/)
      assert.ok(starts() >= 1, 'the kernel started the server')
      const status = await application.invoke('engine:bridge', agentId, { op: 'mcp' }, undefined)
      assert.equal(status.live, true)
      const server = status.servers.find((entry) => entry.name === SERVER_NAME)
      assert.deepEqual(
        { state: server?.state, toolCount: server?.toolCount },
        { state: 'connected', toolCount: FIXTURE_TOOL_COUNT }
      )
      await application.screenshot('engine2-mcp-connected')
    }
  )

  await step('Reconnect closes and reopens the server; it comes back connected', async () => {
    await openPanel()
    const before = starts()
    await serverRow.getByRole('button', { name: `Reconnect ${SERVER_NAME}`, exact: true }).click()
    await until(() => starts() > before, 'a new server process after Reconnect')
    await connectedRow.waitFor({ timeout: WAIT_TIMEOUT_MS })
    assert.match(await serverRow.innerText(), new RegExp(`Connected · ${FIXTURE_TOOL_COUNT} tools`))
    await application.screenshot('engine2-mcp-reconnected')
  })

  await step('Settings → MCP shows the live state and reconnects from the row', async () => {
    await openPanel()
    await panel.getByRole('button', { name: 'MCP settings' }).click()
    await panel.waitFor({ state: 'detached' })
    const reconnect = page.getByRole('button', {
      name: `Reconnect ${SERVER_NAME} in open sessions in this folder`,
      exact: true
    })
    const liveState = page.locator('[data-mcp-row-live][data-mcp-row-state="connected"]', {
      hasText: `Connected · ${FIXTURE_TOOL_COUNT} tools in the open session`
    })
    await liveState.waitFor({ timeout: WAIT_TIMEOUT_MS })
    await application.screenshot('engine2-mcp-settings-live')
    const before = starts()
    await reconnect.click()
    await until(() => starts() > before, 'a new server process after the Settings reconnect')
    await liveState.waitFor({ timeout: WAIT_TIMEOUT_MS })
    await application.test('closeSettings')
  })

  await step('a second conversation reports the server live from its own kernel', async () => {
    // Engine 2 reads mcpServers as a conversation starts: only this one runs the hung server.
    settings.mcpServers[HUNG_SERVER] = {
      type: 'stdio',
      command: process.execPath,
      args: [SERVER_SCRIPT, '--hang', `--log=${hungLog}`],
      enabled: true
    }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2))
    await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off',
        name: SECOND_SESSION
      }
    })
    await chip.waitFor({ timeout: WAIT_TIMEOUT_MS })
    await openPanel()
    // No tool call: the conversation's kernel prewarms and opens its servers by itself.
    await connectedRow.waitFor({ timeout: KERNEL_BOOTSTRAP_TIMEOUT_MS })
    assert.match(await serverRow.innerText(), new RegExp(`Connected · ${FIXTURE_TOOL_COUNT} tools`))
    await closePanel()
  })

  await step(
    'a server that never answers reads as failed, with the reason and Reconnect',
    async () => {
      const hungRow = panel.locator(`[data-mcp-server="${HUNG_SERVER}"]`)
      const failedRow = panel.locator(`[data-mcp-server="${HUNG_SERVER}"][data-mcp-state="failed"]`)
      const reconnect = hungRow.getByRole('button', {
        name: `Reconnect ${HUNG_SERVER}`,
        exact: true
      })
      await openPanel()
      // Only the first read that runs out of time can be an open still in progress.
      await failedRow.waitFor({ timeout: WAIT_TIMEOUT_MS })
      assert.ok(hungStarts() >= 1, 'the kernel started the hung server')
      assert.ok((await hungRow.innerText()).includes(STALLED_TEXT), await hungRow.innerText())
      assert.match(
        await chip.getAttribute('aria-label'),
        /MCP servers: 1 of 2 connected, 1 needs attention/
      )
      assert.equal(await reconnect.isEnabled(), true)
      const seen = new Set()
      const watchUntil = Date.now() + STALLED_WATCH_MS
      while (Date.now() < watchUntil) {
        seen.add(await hungRow.getAttribute('data-mcp-state'))
        await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
      }
      assert.deepEqual([...seen], ['failed'], 'the reads that follow keep it failed')
      await application.screenshot('engine2-mcp-unanswered')
      const before = hungStarts()
      await reconnect.click()
      await until(async () => !(await reconnect.isEnabled()), 'the reconnect to run')
      await until(() => hungStarts() > before, 'a new hung server process after Reconnect')
      await until(
        async () => await reconnect.isEnabled(),
        'the reconnect of the hung server to settle',
        HUNG_RECONNECT_TIMEOUT_MS
      )
      await failedRow.waitFor({ timeout: WAIT_TIMEOUT_MS })
      assert.ok((await hungRow.innerText()).includes(STALLED_TEXT), await hungRow.innerText())
      assert.match(
        await serverRow.innerText(),
        new RegExp(`Connected · ${FIXTURE_TOOL_COUNT} tools`)
      )
      await closePanel()
    }
  )

  await step('no uncaught app errors', async () => {
    application.assertNoErrors()
  })
} catch (error) {
  failure = error
  await application?.screenshot(`${SUITE_NAME}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  if (failure) {
    await captureFailedNativeDiagnostics({
      fixtureDirectory: fixture.root.dir,
      outputDirectory: reportShotsDir('engines')
    }).catch((error) => console.error(`Native failure diagnostics unavailable (${error.name})`))
  }
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
}

const elapsed = `${((performance.now() - started) / 1000).toFixed(1)}s`
if (failure) {
  console.error(`  ✗ ${failure.stack ?? failure}`)
  console.error(`✗ ${SUITE_NAME} failed (${elapsed})`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE_NAME} passed (${elapsed})`)
}
