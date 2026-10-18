import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..', '..')
const tempRoot = await mkdtemp(join(tmpdir(), 'vengeance-prime-auth-oauth-'))
const agentDir = join(tempRoot, 'agent')
const bundlePath = join(tempRoot, 'auth-oauth.mjs')
const previousMock = process.env.VENGEANCE_MOCK
const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR

await mkdir(agentDir)
process.env.VENGEANCE_MOCK = '1'
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir

const electronStub = {
  name: 'electron-stub',
  setup(bundler) {
    bundler.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    bundler.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: `
        globalThis.__primeAuthElectronCalls = { appPath: 0, browser: 0 }
        export const app = {
          isPackaged: false,
          getAppPath() {
            globalThis.__primeAuthElectronCalls.appPath++
            throw new Error('Mock sign-in touched the native helper path')
          }
        }
        export const shell = {
          async openExternal() {
            globalThis.__primeAuthElectronCalls.browser++
            throw new Error('Mock sign-in opened a browser')
          }
        }
      `,
      loader: 'js'
    }))
  }
}

let failed = 0

async function check(name, action) {
  try {
    await action()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.stack : String(error)}`)
  }
}

function eventOf(events, kind) {
  return events.find((event) => event.kind === kind)
}

function assertEventsArePrime(events, loginId) {
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.equal(event.engine, 'prime')
    assert.equal(event.loginId, loginId)
  }
}

try {
  await build({
    entryPoints: [join(root, 'src', 'main', 'engine', 'prime', 'auth-oauth.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(root, 'src', 'shared') },
    plugins: [electronStub],
    logLevel: 'silent'
  })

  const { cancelPrimeOAuth, disposePrimeOAuth, respondPrimeOAuth, startPrimeOAuth } = await import(
    pathToFileURL(bundlePath).href
  )

  async function startFlow(providerId, method = 'oauth') {
    const events = []
    let changeCount = 0
    const loginId = await startPrimeOAuth(
      { providerId, method },
      (event) => events.push(event),
      () => changeCount++
    )
    await new Promise((ready) => setImmediate(ready))
    return { loginId, events, changed: () => changeCount }
  }

  for (const providerId of ['anthropic', 'openai-codex', 'github-copilot', 'xai']) {
    await check(`${providerId} mock sign-in emits its notice and manual-code prompt`, async () => {
      const flow = await startFlow(providerId)
      const notice = eventOf(flow.events, 'notice')?.notice
      const promptEvent = eventOf(flow.events, 'prompt')
      const device = providerId === 'github-copilot' || providerId === 'xai'

      assert.equal(notice?.type, device ? 'device_code' : 'auth_url')
      assert.equal(promptEvent?.prompt.type, 'manual_code')
      assertEventsArePrime(flow.events, flow.loginId)
      assert.equal(respondPrimeOAuth(flow.loginId, promptEvent.promptId, 'private-code'), true)
      assert.equal(eventOf(flow.events, 'done')?.ok, true)
      assert.equal(flow.changed(), 1)
      assert.equal(respondPrimeOAuth(flow.loginId, promptEvent.promptId, 'again'), false)
      assert.ok(!JSON.stringify(flow.events).includes('private-code'))
    })
  }

  await check('Prime Inference offers personal and team selection after a key', async () => {
    const flow = await startFlow('prime-inference')
    const keyPrompt = eventOf(flow.events, 'prompt')

    assert.equal(keyPrompt?.prompt.type, 'secret')
    assert.equal(respondPrimeOAuth(flow.loginId, keyPrompt.promptId, 'private-prime-key'), true)
    const teamPrompt = flow.events.filter((event) => event.kind === 'prompt').at(-1)

    assert.equal(teamPrompt?.prompt.type, 'select')
    assert.deepEqual(
      teamPrompt.prompt.options.map((option) => option.id),
      ['personal', 'team:example']
    )
    assert.equal(respondPrimeOAuth(flow.loginId, teamPrompt.promptId, 'team:example'), true)
    assert.equal(eventOf(flow.events, 'done')?.ok, true)
    assert.equal(flow.changed(), 1)
    assertEventsArePrime(flow.events, flow.loginId)
    assert.ok(!JSON.stringify(flow.events).includes('private-prime-key'))
  })

  for (const method of ['oauth', 'api_key']) {
    await check(
      `Prime traces ${method} completes after one key without a team prompt`,
      async () => {
        const flow = await startFlow('prime-agent-traces', method)
        const promptEvent = eventOf(flow.events, 'prompt')

        assert.equal(
          eventOf(flow.events, 'notice')?.notice.type,
          method === 'oauth' ? 'auth_url' : undefined
        )
        assert.equal(promptEvent?.prompt.type, 'secret')
        assert.equal(
          respondPrimeOAuth(flow.loginId, promptEvent.promptId, 'private-traces-key'),
          true
        )
        assert.equal(flow.events.filter((event) => event.kind === 'prompt').length, 1)
        assert.equal(eventOf(flow.events, 'done')?.ok, true)
        assert.equal(flow.changed(), 1)
        assertEventsArePrime(flow.events, flow.loginId)
        assert.ok(!JSON.stringify(flow.events).includes('private-traces-key'))
      }
    )
  }

  await check('MCP sign-in accepts a manual code without opening a browser', async () => {
    const flow = await startFlow('mcp:test-server')
    const promptEvent = eventOf(flow.events, 'prompt')

    assert.equal(eventOf(flow.events, 'notice')?.notice.type, 'auth_url')
    assert.equal(promptEvent?.prompt.type, 'manual_code')
    assert.equal(respondPrimeOAuth(flow.loginId, promptEvent.promptId, 'private-mcp-code'), true)
    assert.equal(eventOf(flow.events, 'done')?.ok, true)
    assert.equal(flow.changed(), 1)
    assertEventsArePrime(flow.events, flow.loginId)
    assert.ok(!JSON.stringify(flow.events).includes('private-mcp-code'))
  })

  await check('cancel before the scheduled start emits only a cancelled completion', async () => {
    const events = []
    let changeCount = 0
    const loginId = await startPrimeOAuth(
      { providerId: 'anthropic', method: 'oauth' },
      (event) => events.push(event),
      () => changeCount++
    )

    assert.equal(cancelPrimeOAuth(loginId), true)
    await new Promise((ready) => setImmediate(ready))
    assert.deepEqual(
      events.map((event) => event.kind),
      ['done']
    )
    assert.equal(events[0].cancelled, true)
    assert.equal(changeCount, 0)
    assertEventsArePrime(events, loginId)
  })

  await check('cancel an active prompt clears it and rejects later replies', async () => {
    const flow = await startFlow('openai-codex')
    const promptEvent = eventOf(flow.events, 'prompt')

    assert.equal(cancelPrimeOAuth(flow.loginId), true)
    assert.deepEqual(
      flow.events.slice(-2).map((event) => event.kind),
      ['prompt-cancelled', 'done']
    )
    assert.equal(eventOf(flow.events, 'done')?.cancelled, true)
    assert.equal(respondPrimeOAuth(flow.loginId, promptEvent.promptId, 'late'), false)
    assert.equal(flow.changed(), 0)
    assertEventsArePrime(flow.events, flow.loginId)
  })

  await check('disposing sessions cancels each active prompt', async () => {
    const first = await startFlow('anthropic')
    const second = await startFlow('mcp:second-server')

    disposePrimeOAuth()
    for (const flow of [first, second]) {
      assert.equal(eventOf(flow.events, 'done')?.cancelled, true)
      assert.ok(flow.events.some((event) => event.kind === 'prompt-cancelled'))
      assert.equal(flow.changed(), 0)
      assert.equal(cancelPrimeOAuth(flow.loginId), false)
      assertEventsArePrime(flow.events, flow.loginId)
    }
  })

  await check('unsupported provider and invalid team reply fail without saving', async () => {
    await assert.rejects(
      startPrimeOAuth(
        { providerId: 'unknown', method: 'oauth' },
        () => {},
        () => {}
      ),
      /does not support browser sign-in/
    )
    const flow = await startFlow('prime-inference')
    const keyPrompt = eventOf(flow.events, 'prompt')
    assert.equal(respondPrimeOAuth(flow.loginId, keyPrompt.promptId, 'private-key'), true)
    const teamPrompt = flow.events.filter((event) => event.kind === 'prompt').at(-1)

    assert.equal(respondPrimeOAuth(flow.loginId, teamPrompt.promptId, 'unknown-team'), true)
    assert.equal(eventOf(flow.events, 'done')?.ok, false)
    assert.equal(flow.changed(), 0)
    assert.ok(!JSON.stringify(flow.events).includes('private-key'))
  })

  assert.deepEqual(globalThis.__primeAuthElectronCalls, { appPath: 0, browser: 0 })
  assert.equal(existsSync(join(agentDir, 'auth.json')), false)
  console.log('  ✓ mock mode never touched the native helper, browser, or auth.json')

  process.env.VENGEANCE_MOCK = '0'
  const helperName =
    process.platform === 'win32' ? 'vengeance-prime-auth.exe' : 'vengeance-prime-auth'
  const fakeHelper = join(tempRoot, 'resources', 'prime-auth', 'bin', helperName)
  await mkdir(dirname(fakeHelper), { recursive: true })
  // A real helper is executable on POSIX; resolvers may check it before spawning.
  await writeFile(fakeHelper, '', { mode: 0o755 })

  const nativeStub = {
    name: 'native-helper-stub',
    setup(bundler) {
      bundler.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      bundler.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
        contents: `
          globalThis.__primeAuthRealElectron = { appPaths: 0, opened: [] }
          export const app = {
            isPackaged: false,
            getAppPath() {
              globalThis.__primeAuthRealElectron.appPaths++
              return ${JSON.stringify(tempRoot)}
            }
          }
          export const shell = {
            async openExternal(url) {
              globalThis.__primeAuthRealElectron.opened.push(url)
            }
          }
        `,
        loader: 'js'
      }))
      bundler.onResolve({ filter: /^node:child_process$/ }, () => ({
        path: 'child_process',
        namespace: 'stub'
      }))
      bundler.onLoad({ filter: /^child_process$/, namespace: 'stub' }, () => ({
        contents: `
          import { EventEmitter } from 'node:events'
          globalThis.__primeAuthFakeHelper = { mode: 'valid', starts: [] }
          export function execFile() {
            throw new Error('Mocked native helper did not request an engine executable')
          }
          export function spawn(executable, args, options) {
            const state = globalThis.__primeAuthFakeHelper
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = { resume() {} }
            child.stdin = new EventEmitter()
            child.stdin.writable = true
            child.exitCode = null
            child.signalCode = null
            const send = (frame) => setImmediate(() => {
              child.stdout.emit('data', Buffer.from(JSON.stringify(frame) + '\\n'))
            })
            child.stdin.write = (text) => {
              const message = JSON.parse(text)
              if (message.type === 'start') {
                state.starts.push({ executable, args, options, message })
                send({ type: 'notice', notice: {
                  type: 'auth_url', url: 'https://example.com/authorize'
                } })
                send({ type: 'prompt', promptId: 'fixture-prompt', prompt: {
                  type: message.providerId === 'prime-inference' ? 'secret' : 'manual_code',
                  message: 'Enter a fixture response'
                } })
              } else if (message.type === 'reply') {
                const credential = state.mode === 'invalid'
                  ? { type: 'oauth', access: 'private-access', expires: 'invalid' }
                  : state.mode === 'traces-key'
                    ? { type: 'api_key', key: 'fixture-traces-key' }
                    : state.mode === 'prime-preserve'
                    ? { type: 'api_key', key: 'fixture-prime-key' }
                    : {
                        type: 'oauth', access: 'private-access', refresh: 'private-refresh',
                        expires: 4102444800000, accountId: 'fixture-account'
                      }
                send({
                  type: 'done', ok: true, credential,
                  preservePrimeTeam: state.mode === 'prime-preserve'
                })
              }
              return true
            }
            child.stdin.end = () => {
              child.stdin.writable = false
              child.exitCode = 0
              setImmediate(() => child.emit('close', 0))
            }
            child.kill = () => {
              child.exitCode = 0
              setImmediate(() => child.emit('close', 0))
            }
            send({
              type: 'ready', protocol: 1,
              revision: '763094e1b6a7c17450ee8399b06cda1853847ca5',
              providers: ['openai-codex', 'prime-inference', 'prime-agent-traces', 'anthropic'],
              mcp: true
            })
            return child
          }
        `,
        loader: 'js'
      }))
    }
  }

  const realBundlePath = join(tempRoot, 'auth-oauth-real.mjs')
  await build({
    entryPoints: [join(root, 'src', 'main', 'engine', 'prime', 'auth-oauth.ts')],
    outfile: realBundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(root, 'src', 'shared') },
    plugins: [nativeStub],
    logLevel: 'silent'
  })

  const realOAuth = await import(pathToFileURL(realBundlePath).href)
  const authPath = join(agentDir, 'auth.json')
  await writeFile(
    authPath,
    JSON.stringify({
      unrelated: { enabled: true },
      'prime-inference': {
        type: 'api_key',
        key: 'fixture-prime-key',
        primeTeam: { teamId: 'saved-team', name: 'Saved Team' }
      }
    })
  )

  async function waitForEvent(events, kind) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const event = eventOf(events, kind)
      if (event) return event
      await new Promise((ready) => setTimeout(ready, 5))
    }
    throw new Error(`Timed out waiting for ${kind}`)
  }

  async function runStubbedFlow(providerId, mode, method = 'oauth') {
    globalThis.__primeAuthFakeHelper.mode = mode
    const events = []
    let changeCount = 0
    const loginId = await realOAuth.startPrimeOAuth(
      { providerId, method },
      (event) => events.push(event),
      () => changeCount++
    )
    const promptEvent = await waitForEvent(events, 'prompt')
    assert.equal(realOAuth.respondPrimeOAuth(loginId, promptEvent.promptId, 'private-reply'), true)
    const doneEvent = await waitForEvent(events, 'done')
    assertEventsArePrime(events, loginId)
    assert.ok(!JSON.stringify(events).includes('private-access'))
    assert.ok(!JSON.stringify(events).includes('private-reply'))
    return { events, doneEvent, changeCount }
  }

  await check('valid helper credential saves atomically and keeps unrelated accounts', async () => {
    const flow = await runStubbedFlow('openai-codex', 'valid')
    const stored = JSON.parse(await readFile(authPath, 'utf8'))

    assert.equal(flow.doneEvent.ok, true)
    assert.equal(flow.changeCount, 1)
    assert.deepEqual(stored.unrelated, { enabled: true })
    assert.equal(stored['openai-codex'].access, 'private-access')
    assert.equal(stored['openai-codex'].refresh, 'private-refresh')
    assert.equal(stored['openai-codex'].accountId, 'fixture-account')
    assert.deepEqual(globalThis.__primeAuthRealElectron.opened, ['https://example.com/authorize'])
  })

  await check('Prime key refresh keeps a saved team when the key matches', async () => {
    const flow = await runStubbedFlow('prime-inference', 'prime-preserve', 'api_key')
    const stored = JSON.parse(await readFile(authPath, 'utf8'))

    assert.equal(flow.doneEvent.ok, true)
    assert.equal(flow.changeCount, 1)
    assert.deepEqual(stored['prime-inference'].primeTeam, {
      teamId: 'saved-team',
      name: 'Saved Team'
    })
    assert.equal(globalThis.__primeAuthFakeHelper.starts.at(-1).message.method, 'api_key')
  })

  await check(
    'traces helper key saves in its own account slot without UI secret leakage',
    async () => {
      const flow = await runStubbedFlow('prime-agent-traces', 'traces-key', 'api_key')
      const stored = JSON.parse(await readFile(authPath, 'utf8'))

      assert.equal(flow.doneEvent.ok, true)
      assert.equal(flow.changeCount, 1)
      assert.deepEqual(stored['prime-agent-traces'], {
        type: 'api_key',
        key: 'fixture-traces-key'
      })
      assert.deepEqual(stored['prime-inference'].primeTeam, {
        teamId: 'saved-team',
        name: 'Saved Team'
      })
      assert.ok(!JSON.stringify(flow.events).includes('fixture-traces-key'))
      assert.equal(globalThis.__primeAuthFakeHelper.starts.at(-1).message.method, 'api_key')
    }
  )

  await check('invalid helper credential never overwrites the account store', async () => {
    const before = await readFile(authPath, 'utf8')
    const flow = await runStubbedFlow('anthropic', 'invalid')

    assert.equal(flow.doneEvent.ok, false)
    assert.equal(flow.changeCount, 0)
    assert.equal(await readFile(authPath, 'utf8'), before)
  })

  assert.equal(globalThis.__primeAuthFakeHelper.starts.length, 4)
  for (const start of globalThis.__primeAuthFakeHelper.starts) {
    assert.equal(start.message.agentDir, agentDir)
    assert.equal(start.options.windowsHide, true)
  }
  realOAuth.disposePrimeOAuth()
} finally {
  if (previousMock === undefined) delete process.env.VENGEANCE_MOCK
  else process.env.VENGEANCE_MOCK = previousMock
  if (previousAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR
  else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir

  const resolvedTempRoot = await realpath(tempRoot)
  const resolvedSystemTemp = await realpath(tmpdir())
  assert.ok(relative(resolvedSystemTemp, resolvedTempRoot).split(sep)[0] !== '..')
  await rm(resolvedTempRoot, { recursive: true, force: true })
}

if (failed) process.exitCode = 1
