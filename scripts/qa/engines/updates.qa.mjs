import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { createEngineFixture } from './integration-fixture.mjs'

const UPDATE_TIMEOUT_MS = 60_000
const ENGINE_POLICY = /Engine updates are included with Vengeance releases/

async function recordBoundaries(application) {
  await application.app.evaluate(() => {
    const childProcess = process.getBuiltinModule('node:child_process')
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const records = { processes: [], network: [] }
    globalThis.__qaUpdateBoundaries = records
    for (const method of ['spawn', 'execFile']) {
      const original = childProcess[method]
      childProcess[method] = (...parameters) => {
        const [executable, args, options] = parameters
        records.processes.push({
          executable,
          args,
          piDirectory: options?.env?.PI_CODING_AGENT_DIR,
          primeDirectory: options?.env?.PRIME_AGENT_CODING_AGENT_DIR
        })
        return original(...parameters)
      }
    }
    syncBuiltinESMExports()
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : (input.url ?? String(input))
      records.network.push(url)
      throw new Error(`Unexpected updater network request: ${url}`)
    }
  })
  await application.page.evaluate(() => {
    window.__qaUpdateEvents = { done: [], applied: [], settingsDone: [] }
    for (const kind of ['done', 'applied']) {
      window.vengeance.on(`updates:${kind}`, (event) => {
        window.__qaUpdateEvents[kind].push(event)
      })
    }
    window.vengeance.on('settings:process-done', (event) => {
      window.__qaUpdateEvents.settingsDone.push(event)
    })
  })
}

async function updatePackages(application, engine) {
  const runId = await application.invoke('updates:run', { engine, target: 'packages' })
  await application.page.waitForFunction(
    (identifier) => window.__qaUpdateEvents.done.some((event) => event.runId === identifier),
    runId,
    { timeout: UPDATE_TIMEOUT_MS }
  )
  const result = await application.page.evaluate(
    (identifier) => window.__qaUpdateEvents.done.find((event) => event.runId === identifier),
    runId
  )
  assert.equal(result.ok, true, result.error)
}

async function step(label, action) {
  await action()
  console.log(`  ✓ ${label}`)
}

const fixture = await createEngineFixture()
let application
try {
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    outDir: reportShotsDir('engines'),
    env: {
      ...fixture.environment,
      VENGEANCE_PRIME_EXECUTABLE: undefined,
      PI_OFFLINE: undefined,
      PRIME_AGENT_OFFLINE: undefined
    }
  })
  await application.invoke('app:set-state', { features: { updates: { mode: 'off' } } })
  await recordBoundaries(application)
  const primeSettingsPath = join(fixture.primeDirectory, 'settings.json')
  const savedSettings = await readFile(primeSettingsPath, 'utf8')

  await step(
    'both update panels report the included builds without engine feed requests',
    async () => {
      for (const engine of ['pi', 'prime']) {
        const state = await application.invoke('updates:check', engine)
        assert.equal(state.error, undefined)
        assert.equal(state.engineId, engine)
        assert.equal(state.engine.available, false)
        assert.equal(state.engine.managedByApp, true)
        assert.match(state.engine.current, /\+vengeance\./)
        assert.match(state.engine.note, ENGINE_POLICY)
      }
      const records = await application.app.evaluate(() => globalThis.__qaUpdateBoundaries)
      assert.deepEqual(records.network, [])
    }
  )

  await step('self-update, rollback and channel IPC cannot replace either engine', async () => {
    for (const engine of ['pi', 'prime']) {
      for (const target of ['engine', 'all', 'rollback']) {
        await assert.rejects(application.invoke('updates:run', { engine, target }), ENGINE_POLICY)
      }
      for (const source of ['pi', 'self', '--self']) {
        await assert.rejects(
          application.invoke('updates:run', { engine, target: 'package', source }),
          /Choose a package/
        )
      }
    }
    await assert.rejects(
      application.invoke('updates:set-channel', 'prime', 'nightly'),
      ENGINE_POLICY
    )
    assert.equal(await readFile(primeSettingsPath, 'utf8'), savedSettings)
    assert.deepEqual(await application.page.evaluate(() => window.__qaUpdateEvents.applied), [])
  })

  let agentId
  let pendingRequest
  let enginePid
  await step('start a held Engine reply before Engine 2 package maintenance', async () => {
    const workspace = await application.openWorkspace()
    agentId = workspace.agentId
    enginePid = (await application.invoke('engine:list')).find(
      (agent) => agent.agentId === agentId
    ).pid
    fixture.piServer.queue(turn.hang({ text: 'Waiting for package maintenance.' }))
    const from = fixture.piServer.requests.length
    await application.send('hold')
    pendingRequest = await fixture.piServer.waitForRequest(undefined, { from })
  })

  await step('native package updates remain scoped and do not replace active engines', async () => {
    await updatePackages(application, 'prime')
    await updatePackages(application, 'pi')
    const settingsRequest = {
      engine: 'prime',
      cwd: fixture.root.dir,
      channel: 'settings:package-run',
      args: [{ action: 'update-all', cwd: fixture.root.dir }]
    }
    const runId = await application.invoke('engine:settings', settingsRequest)
    await application.page.waitForFunction(
      (identifier) =>
        window.__qaUpdateEvents.settingsDone.some((event) => event.runId === identifier),
      runId,
      { timeout: UPDATE_TIMEOUT_MS }
    )
    const settingsResult = await application.page.evaluate(
      (identifier) =>
        window.__qaUpdateEvents.settingsDone.find((event) => event.runId === identifier),
      runId
    )
    assert.equal(settingsResult.ok, true, settingsResult.error)
    assert.equal(settingsResult.engine, 'prime')
    await assert.rejects(
      application.invoke('engine:settings', {
        ...settingsRequest,
        args: [{ action: 'update', source: 'self', cwd: fixture.root.dir }]
      }),
      ENGINE_POLICY
    )
    const records = await application.app.evaluate(() => globalThis.__qaUpdateBoundaries)
    const primeUpdate = records.processes.find(
      (record) => record.args?.[0] === 'package' && record.args[1] === 'update'
    )
    assert.deepEqual(primeUpdate.args, ['package', 'update'])
    assert.equal(primeUpdate.primeDirectory, fixture.primeDirectory)
    const piUpdate = records.processes.find(
      (record) =>
        record.args?.includes('update') &&
        record.args.includes('--extensions') &&
        record.executable !== primeUpdate.executable
    )
    assert.ok(piUpdate)
    assert.equal(piUpdate.piDirectory, fixture.piDirectory.dir)
    const active = (await application.invoke('engine:list')).find(
      (agent) => agent.agentId === agentId
    )
    assert.equal(active.pid, enginePid)
    assert.equal(active.busy, true)
    assert.equal(pendingRequest.outcome, 'streaming')
    await application.rpc({ type: 'abort' }, agentId)
    assert.equal(await fixture.piServer.waitForOutcome(pendingRequest), 'aborted')
  })

  await step(
    'packaged app self-update resolves electron-updater and checks a generic feed',
    async () => {
      let feedVersion = await application.app.evaluate(({ app }) => app.getVersion())
      const feedServer = createServer((req, res) => {
        if (req.url?.includes('.yml')) {
          res.writeHead(200, { 'content-type': 'text/yaml' })
          res.end(
            [
              `version: ${feedVersion}`,
              'files:',
              '  - url: Vengeance-Setup.exe',
              '    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
              '    size: 1024',
              'path: Vengeance-Setup.exe',
              'sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
              "releaseDate: '2026-10-18T00:00:00.000Z'",
              ''
            ].join('\n')
          )
          return
        }
        res.writeHead(404).end()
      })
      await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve))
      const { port } = feedServer.address()
      try {
        await application.app.evaluate(({ app }) => {
          Object.defineProperty(app, 'isPackaged', { value: true, configurable: true })
        })
        await application.invoke('app:set-state', {
          features: { updates: { mode: 'notify', feedUrl: `http://127.0.0.1:${port}` } }
        })
        const upToDate = await application.invoke('updates:check', 'pi')
        assert.equal(upToDate.app.status, 'idle', upToDate.app.message)
        assert.equal(upToDate.app.message, undefined)

        feedVersion = '99.0.0'
        const available = await application.invoke('updates:check', 'pi')
        assert.equal(available.app.status, 'available', available.app.message)
        assert.equal(available.app.latest, '99.0.0')
        assert.match(available.app.releaseUrl ?? '', /\/releases\/tag\/v99\.0\.0$/)
      } finally {
        await application.app.evaluate(({ app }) => {
          Object.defineProperty(app, 'isPackaged', { value: false, configurable: true })
        })
        await application.invoke('app:set-state', {
          features: { updates: { mode: 'off', feedUrl: undefined } }
        })
        await new Promise((resolve) => feedServer.close(resolve))
      }
    }
  )

  await step(
    'offline update state keeps both bundled versions and refuses package downloads',
    async () => {
      await application.invoke('updates:set-offline', true)
      for (const engine of ['pi', 'prime']) {
        const state = await application.invoke('updates:check', engine)
        assert.equal(state.offline, true)
        assert.equal(state.engine.managedByApp, true)
        await assert.rejects(
          application.invoke('updates:run', { engine, target: 'packages' }),
          /offline mode/
        )
      }
    }
  )

  await step('the Updates sheet explains app-owned engine releases', async () => {
    await application.page.keyboard.press('ControlOrMeta+k')
    await application.page.getByRole('combobox').first().fill('Check for updates')
    await application.page
      .getByRole('option', { name: /^Check for updates/ })
      .first()
      .click()
    const sheet = application.page.getByRole('dialog', { name: 'Updates' })
    await sheet.waitFor()
    for (const label of ['Engine 1', 'Engine 2']) {
      await sheet.getByRole('radio', { name: label, exact: true }).click()
      await sheet.getByText(ENGINE_POLICY).waitFor()
      assert.equal(await sheet.getByRole('button', { name: /Install engine|Rollback/i }).count(), 0)
      await application.screenshot(`bundled-${label.replaceAll(' ', '-').toLowerCase()}-updates`)
    }
  })
  application.assertNoErrors()
  console.log('✓ engine-updates passed (7 checks)')
} finally {
  try {
    await application?.close({ beforeCleanup: fixture.stopNativeDaemon })
  } finally {
    await fixture.cleanup()
  }
}
