import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makePng, until } from '../chat/helpers.mjs'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const SUITE_NAME = 'engine-switch'
const OUTPUT_DIRECTORY = reportShotsDir(SUITE_NAME)
const BEFORE_COMPACTION = 'Keep the complete earlier conversation, including this marker.'
const SELECTED_BRANCH = 'This is the selected conversation branch.'
const OTHER_BRANCH = 'This sibling branch must stay in the source archive.'
const TOOL_OUTPUT = 'The complete historical tool output.'
const EXISTING_SUMMARY = 'A native compaction summary that was already present.'
const IMAGE_SIZE = 16
const IMAGE_DATA = makePng(IMAGE_SIZE, IMAGE_SIZE, [90, 120, 150]).toString('base64')
const WAIT_TIMEOUT_MS = 120_000
const fixture = await createEngineFixture()
const report = { checks: [], screenshots: [] }
let application
let failure

async function check(label, action) {
  console.log(`  • ${label}`)
  await action()
  report.checks.push(label)
  console.log(`    ✓ ${label}`)
}

async function accountFiles() {
  const result = {}
  for (const [engine, directory] of [
    ['pi', fixture.piDirectory.dir],
    ['prime', fixture.primeDirectory]
  ]) {
    for (const name of ['auth.json', 'models.json', 'settings.json']) {
      result[`${engine}/${name}`] = await readFile(join(directory, name), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    }
  }
  return result
}

async function seedSource(cwd) {
  const { SessionManager } = await import(
    pathToFileURL(
      join(
        ROOT,
        '.engine-staging',
        'bundled',
        'pi',
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'core',
        'session-manager.js'
      )
    ).href
  )
  const native = SessionManager.create(cwd, fixture.root.path('source-sessions'))
  const timestamp = Date.now()
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  native.appendModelChange(FAKE_PROVIDER, FAKE_MODELS.openai)
  native.appendMessage({ role: 'user', content: BEFORE_COMPACTION, timestamp })
  const retained = native.appendMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'Keep this attachment and its tool result.' },
      { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }
    ],
    timestamp
  })
  native.appendMessage({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'history-read', name: 'read', arguments: { path: 'a.txt' } }],
    api: 'openai-completions',
    provider: FAKE_PROVIDER,
    model: FAKE_MODELS.openai,
    usage,
    stopReason: 'toolUse',
    timestamp
  })
  native.appendMessage({
    role: 'toolResult',
    toolCallId: 'history-read',
    toolName: 'read',
    content: [{ type: 'text', text: TOOL_OUTPUT }],
    isError: false,
    timestamp
  })
  const compacted = native.appendCompaction(EXISTING_SUMMARY, retained, 500)
  native.appendMessage({ role: 'user', content: OTHER_BRANCH, timestamp })
  native.branch(compacted)
  native.appendMessage({ role: 'user', content: SELECTED_BRANCH, timestamp })
  native.appendSessionInfo('Engine switch history')
  return native.getSessionFile()
}

async function waitForEngine(agentId, engine) {
  return until(
    async () => {
      const info = (await application.invoke('engine:list')).find(
        (entry) => entry.agentId === agentId
      )
      return info?.engine === engine && info.status === 'ready' ? info : undefined
    },
    { label: `${engine} transfer ready`, timeoutMs: WAIT_TIMEOUT_MS }
  )
}

async function assertTransferredHistory(agentId, engine) {
  const info = await waitForEngine(agentId, engine)
  const { entries } = await application.rpc({ type: 'get_entries' }, agentId)
  const serialized = JSON.stringify(entries)
  for (const marker of [
    BEFORE_COMPACTION,
    SELECTED_BRANCH,
    TOOL_OUTPUT,
    EXISTING_SUMMARY,
    IMAGE_DATA
  ]) {
    assert.ok(serialized.includes(marker), `${engine} full history contains ${marker.slice(0, 50)}`)
  }
  assert.ok(!serialized.includes(OTHER_BRANCH), 'Only the selected branch moves to the destination')
  assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1)
  assert.ok(
    entries.some((entry) => entry.type === 'message' && entry.message.role === 'toolResult')
  )
  return info
}

async function switchEngine(agentId, engine, cwd, extra = {}) {
  const result = await application.invoke('engine:switch', agentId, { engine, cwd, ...extra })
  assert.equal(result.agentId, agentId, 'The app conversation identity remains stable')
  return waitForEngine(agentId, engine)
}

async function continueConversation(agentId, engine, expectedProvider, expectedModel) {
  const server = engine === 'pi' ? fixture.piServer : fixture.primeServer
  const from = server.requests.length
  server.queue(turn.text(`Continued with ${engine}.`))
  await application.rpc({ type: 'prompt', message: 'Continue briefly.' }, agentId)
  const request = await server.waitForRequest((entry) => entry.method === 'POST', { from })
  await server.waitForOutcome(request)
  const payload = inspectRequest(request)
  assert.equal(payload.model, expectedModel)
  assert.ok(payload.imageCount > 0, 'The native provider receives the historical image')
  assert.ok(payload.toolResults.some((result) => result.text.includes(TOOL_OUTPUT)))
  await until(async () => !(await application.rpc({ type: 'get_state' }, agentId)).isStreaming, {
    label: 'transferred native conversation settled',
    timeoutMs: WAIT_TIMEOUT_MS
  })
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(state.model.provider, expectedProvider)
  assert.equal(state.model.id, expectedModel)
}

try {
  // Native account startup creates an empty auth store on first use.
  await writeFile(join(fixture.primeDirectory, 'auth.json'), '{}', { flag: 'wx' }).catch(
    (error) => {
      if (error.code !== 'EEXIST') throw error
    }
  )
  const modelsPath = join(fixture.primeDirectory, 'models.json')
  const models = JSON.parse(await readFile(modelsPath, 'utf8'))
  for (const model of models.providers[PRIME_PROVIDER].models) model.input = ['text', 'image']
  await writeFile(modelsPath, JSON.stringify(models))
  const settingsPath = join(fixture.piDirectory.dir, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  await writeFile(settingsPath, JSON.stringify({ ...settings, defaultModel: FAKE_MODELS.openai }))
  const cwd = await fixture.root.folder('workspace', { 'README.md': '# Engine switch QA\n' })
  const sourcePath = await seedSource(cwd)
  application = await launchApp({
    exe: process.env.QA_PACKAGED_EXE,
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  const { agentId } = await application.openWorkspace({
    cwd,
    args: { engine: 'pi', sessionPath: sourcePath, approve: true }
  })
  await waitForEngine(agentId, 'pi')
  const sourceBytes = await readFile(sourcePath, 'utf8')
  const accountsBefore = await accountFiles()

  await check('Engine to Engine 2 carries the complete selected branch', async () => {
    const result = await switchEngine(agentId, 'prime', cwd)
    assert.notEqual(result.sessionFile, sourcePath)
    await assertTransferredHistory(agentId, 'prime')
    assert.equal(await readFile(sourcePath, 'utf8'), sourceBytes, 'Source native archive is intact')
    await continueConversation(agentId, 'prime', PRIME_PROVIDER, PRIME_MODELS.reasoning)
  })

  await check('A failed destination leaves the source conversation usable', async () => {
    const source = await application.rpc({ type: 'get_state' }, agentId)
    await assert.rejects(
      switchEngine(agentId, 'pi', cwd, { provider: 'missing-provider', model: 'missing-model' })
    )
    const recovered = await application.rpc({ type: 'get_state' }, agentId)
    assert.equal(recovered.sessionId, source.sessionId)
    assert.equal(recovered.sessionFile, source.sessionFile)
    await continueConversation(agentId, 'prime', PRIME_PROVIDER, PRIME_MODELS.reasoning)
  })

  await check('Engine 2 to Engine keeps the app identity and native conversation', async () => {
    await switchEngine(agentId, 'pi', cwd)
    await assertTransferredHistory(agentId, 'pi')
    await continueConversation(agentId, 'pi', FAKE_PROVIDER, FAKE_MODELS.openai)
    assert.deepEqual(await accountFiles(), accountsBefore, 'Account configuration remains isolated')
  })

  await check('Switching refuses a running turn without interrupting it', async () => {
    const from = fixture.piServer.requests.length
    fixture.piServer.queue(turn.hang())
    await application.rpc({ type: 'prompt', message: 'Wait for the next instruction.' }, agentId)
    await fixture.piServer.waitForRequest((entry) => entry.method === 'POST', { from })
    await assert.rejects(switchEngine(agentId, 'prime', cwd), /idle|active|finish|wait/i)
    await application.rpc({ type: 'abort' }, agentId)
    await waitForEngine(agentId, 'pi')
  })

  await check('A new Engine 2 conversation stays empty after switching to Engine', async () => {
    const emptyId = randomUUID()
    try {
      await application.invoke('engine:create', { engine: 'prime', cwd }, emptyId)
      await switchEngine(emptyId, 'pi', cwd)
      const { messages } = await application.rpc({ type: 'get_messages' }, emptyId)
      assert.deepEqual(messages, [], 'Native startup metadata must not become conversation text')
    } finally {
      await application.invoke('engine:dispose', emptyId)
    }
  })

  report.screenshots.push(await application.screenshot('engine-switch-roundtrip'))
  application.assertNoErrors()
} catch (error) {
  failure = error
  await application?.screenshot('FAILED').catch(() => undefined)
} finally {
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await writeFile(
    join(OUTPUT_DIRECTORY, 'report.json'),
    `${JSON.stringify({ ...report, failure: failure?.stack }, null, 2)}\n`
  )
}

if (failure) {
  console.error(failure.stack ?? failure)
  process.exitCode = 1
} else {
  console.log(`✓ Engine switching: ${report.checks.length} checks passed`)
}
