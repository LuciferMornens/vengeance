// Extension providers are read in a short-lived child process (the provider host), never in the
// app's main process:
//   - the startup catalog loads no extension code;
//   - Settings → Providers lists the providers an extension registers, read by the host;
//   - a built-in provider an extension re-registers stays a built-in (no "Extension"), with a quiet
//     "Modified by <extension>" note;
//   - an extension OAuth sign-in runs in the host: its URL, prompt and stored credential reach the app;
//   - a host that crashes mid sign-in fails that sign-in once, with a plain message;
//   - the host exits after a minute without work, without errors or toasts.
// The fixture extension appends `<pid> <script>` to a marker file each time it loads, so the test
// sees which processes ran it. No workspace is opened, so no engine loads it.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runSuite } from '../lib/suite.mjs'
import {
  LAUNCH,
  openSettings,
  providerRow,
  readTempAuth,
  sleep,
  softSteps,
  stubMainNetwork,
  waitUntil
} from './helpers.mjs'

const execFileAsync = promisify(execFile)

const MARKER = 'extension-loads.txt'
const EXTENSION_FILE = 'qa-host-provider'
const OAUTH_PROVIDER = 'qa-host-oauth'
const SIGN_IN_URL = 'https://auth.example.invalid/qa-host/authorize'
const SIGN_IN_CODE = 'qa-code-1234'
/** provider-host.ts stops a host after 60 s without work. */
const HOST_IDLE_MS = 60_000
const HOST_EXIT_TIMEOUT_MS = 100_000
/** The config watcher's debounce, so the sign-in's settings.json write (device id) has been seen. */
const WATCHER_SETTLE_MS = 2_000
const GONE_READINGS = 3
const CRASH_MESSAGE = 'The extensions stopped unexpectedly.'

function extensionSource(server, markerPath) {
  const model = (id, name) => ({
    id,
    name,
    reasoning: false,
    input: ['text'],
    contextWindow: 100000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  })
  return `import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

export default function (pi) {
  appendFileSync(${JSON.stringify(markerPath)}, process.pid + ' ' + basename(process.argv[1] ?? '') + '\\n')
  pi.registerProvider('qa-host', {
    name: 'QA Host',
    baseUrl: ${JSON.stringify(server.anthropicBaseUrl)},
    api: 'anthropic-messages',
    apiKey: 'qa-host-key',
    models: [${JSON.stringify(model('qa-host-model', 'QA Host Model'))}]
  })
  pi.registerProvider(${JSON.stringify(OAUTH_PROVIDER)}, {
    name: 'QA Host OAuth',
    baseUrl: ${JSON.stringify(server.anthropicBaseUrl)},
    api: 'anthropic-messages',
    oauth: {
      name: 'QA Host OAuth (subscription)',
      isSubscription: true,
      async login(callbacks) {
        callbacks.onAuth({ url: ${JSON.stringify(SIGN_IN_URL)} })
        const code = await callbacks.onPrompt({ message: 'Paste the QA code' })
        return { access: 'qa-access-' + code, refresh: 'qa-refresh', expires: Date.now() + 3600000 }
      },
      async refreshToken(credentials) { return credentials },
      getApiKey(credentials) { return credentials.access }
    },
    models: [${JSON.stringify(model('qa-host-oauth-model', 'QA Host OAuth Model'))}]
  })
  // Re-registering a built-in with only a base URL keeps its models (custom-provider.md).
  pi.registerProvider('openrouter', { baseUrl: ${JSON.stringify(server.openaiBaseUrl)} })
}
`
}

/** `{ pid, script }` for every load of the fixture extension so far. */
async function extensionLoads(agentDir) {
  const text = await readFile(join(agentDir.dir, MARKER), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, script] = line.split(' ')
      return { pid: Number(pid), script }
    })
}

async function isRunning(pid) {
  const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  return stdout.includes(`"${pid}"`)
}

async function runningPids(pids) {
  const running = await Promise.all(pids.map(isRunning))
  return pids.filter((_, index) => running[index])
}

/**
 * True once `pids` have been gone for several polls in a row: on a busy machine a single process query
 * can miss a running process.
 */
function goneForGood(pids) {
  let goneReadings = 0
  return async () => {
    goneReadings = (await runningPids(pids)).length === 0 ? goneReadings + 1 : 0
    return goneReadings >= GONE_READINGS
  }
}

const hostPidsOf = async (agentDir) => [...new Set((await extensionLoads(agentDir)).map((load) => load.pid))]

await runSuite(
  'auth-provider-host',
  async ({ server, agentDir, app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    const network = await stubMainNetwork(app)
    const mainPid = await app.app.evaluate(() => process.pid)

    await step('fixture: a provider extension that records which process loads it', async () => {
      await agentDir.writeText(
        `extensions/${EXTENSION_FILE}.js`,
        extensionSource(server, join(agentDir.dir, MARKER))
      )
    })

    await step('the regular catalog loads no extension code', async () => {
      const catalog = await app.invoke('settings:catalog')
      assert.deepEqual(await extensionLoads(agentDir), [])
      assert.equal(
        catalog.providers.find((provider) => provider.id === 'qa-host'),
        undefined
      )
    })

    await step('Settings → Providers lists the extension providers, read by the host', async () => {
      await openSettings(app, 'providers', 'Providers & accounts')
      await providerRow(page, 'qa-host').waitFor({ timeout: 30_000 })
      await providerRow(page, OAUTH_PROVIDER).waitFor()
      const loads = await extensionLoads(agentDir)
      assert.ok(loads.length > 0)
      assert.deepEqual(
        loads.filter((load) => load.pid === mainPid),
        [],
        'the main process loaded the extension'
      )
      assert.deepEqual(
        [...new Set(loads.map((load) => load.script))],
        ['provider-host.js']
      )
      await app.screenshot('host-01-providers', { settleMs: 400 })
    })

    await soft.step('the catalog keeps the host’s list without loading anything', async () => {
      const before = (await extensionLoads(agentDir)).length
      const catalog = await app.invoke('settings:catalog')
      const keyed = catalog.providers.find((provider) => provider.id === 'qa-host')
      assert.equal(keyed?.fromExtension, true)
      assert.equal(keyed?.status.configured, true)
      const model = catalog.models.find((m) => m.provider === 'qa-host' && m.id === 'qa-host-model')
      assert.equal(model?.fromExtension, true)
      assert.equal(model?.available, true)
      assert.equal((await extensionLoads(agentDir)).length, before)
    })

    await soft.step('a built-in an extension re-registers stays a built-in', async () => {
      const catalog = await app.invoke('settings:catalog')
      const openrouter = catalog.providers.find((provider) => provider.id === 'openrouter')
      assert.equal(openrouter?.fromExtension, undefined)
      assert.equal(openrouter?.modifiedBy, EXTENSION_FILE)
      const models = catalog.models.filter((m) => m.provider === 'openrouter')
      assert.ok(models.length > 0)
      assert.deepEqual(
        models.filter((m) => m.fromExtension),
        []
      )
      await page.getByPlaceholder('Filter providers').fill('OpenRouter')
      const row = providerRow(page, 'openrouter')
      await row.getByText(`Modified by ${EXTENSION_FILE}`).waitFor()
      await row.scrollIntoViewIfNeeded()
      assert.equal(await row.getByText('Extension', { exact: true }).count(), 0)
      await app.screenshot('host-02-modified-builtin', { settleMs: 300 })
      await page.getByPlaceholder('Filter providers').fill('')
    })

    await soft.step('an extension OAuth sign-in runs in the host and stores the credential', async () => {
      await providerRow(page, OAUTH_PROVIDER).getByRole('button', { name: 'Sign in' }).click()
      const dialog = page.getByRole('dialog', { name: 'Sign in to QA Host OAuth' })
      await dialog.locator('code').filter({ hasText: SIGN_IN_URL }).waitFor()
      assert.deepEqual(await network.opened(), [SIGN_IN_URL])
      await dialog.locator('input').fill(SIGN_IN_CODE)
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await dialog.getByText('Connected').waitFor()
      const stored = (await readTempAuth(agentDir))?.[OAUTH_PROVIDER]
      assert.equal(stored?.type, 'oauth')
      assert.equal(stored?.access, `qa-access-${SIGN_IN_CODE}`)
      await dialog.waitFor({ state: 'detached' })
      const connected = page.locator('section', { has: page.getByRole('heading', { name: 'Connected' }) })
      await providerRow(connected, OAUTH_PROVIDER).waitFor()
    })

    await step('after the sign-in the catalog still lists the extension providers', async () => {
      await sleep(WATCHER_SETTLE_MS)
      const catalog = await app.invoke('settings:catalog')
      const oauth = catalog.providers.find((provider) => provider.id === OAUTH_PROVIDER)
      assert.equal(oauth?.status.configured, true)
      assert.equal(oauth?.fromExtension, true)
    })

    await step('the main process never loaded the extension', async () => {
      const loads = await extensionLoads(agentDir)
      assert.deepEqual(
        loads.filter((load) => load.pid === mainPid),
        []
      )
    })

    await soft.step('a host that crashes during a sign-in fails it once, with a plain message', async () => {
      const row = providerRow(page, OAUTH_PROVIDER)
      await row.getByRole('button', { name: 'Reconnect' }).click()
      const dialog = page.getByRole('dialog', { name: 'Sign in to QA Host OAuth' })
      await dialog.locator('input').waitFor()
      const running = await runningPids(await hostPidsOf(agentDir))
      assert.equal(running.length, 1, 'one host runs the sign-in')
      // The test's own app started this process (Vengeance → provider host).
      await execFileAsync('taskkill', ['/PID', String(running[0]), '/T', '/F'])
      await dialog.getByText('Sign-in failed').waitFor()
      assert.equal(await dialog.getByText(CRASH_MESSAGE, { exact: true }).count(), 1)
      assert.equal(await page.locator('[data-toaster]').getByText(CRASH_MESSAGE).count(), 0)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
    })

    await step('the host exits after a minute without work, silently', async () => {
      await openSettings(app, 'models', 'Models')
      await app.invoke('settings:extension-providers')
      const idleSince = Date.now()
      const hostPids = await hostPidsOf(agentDir)
      assert.ok((await runningPids(hostPids)).length > 0, 'a host is running')
      await waitUntil(goneForGood(hostPids), {
        timeoutMs: HOST_EXIT_TIMEOUT_MS,
        label: `provider host ${hostPids.join(', ')} to exit`
      })
      const idle = Date.now() - idleSince
      assert.ok(idle >= HOST_IDLE_MS - WATCHER_SETTLE_MS, `the host exited after ${idle} ms`)
      assert.equal(await page.locator('[data-toaster] [role="alert"]').count(), 0, 'no error toast')
      assert.deepEqual(app.errors(), [])
    })

    soft.finish()
  },
  { launch: { ...LAUNCH, env: { OPENROUTER_API_KEY: undefined } } }
)
