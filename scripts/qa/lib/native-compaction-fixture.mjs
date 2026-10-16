import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from '../chat/helpers.mjs'
import { launchApp, reportShotsDir } from './app.mjs'
import { inspectRequest } from './fake-llm.mjs'
import { createEngineFixture } from '../engines/integration-fixture.mjs'

export const MODEL = 'gpt-6.1-sol'
export const TASK =
  'Read operands.txt, multiply its numbers, save result.txt, and report the result.'
export const nativeRequest = (request) => request.body?.input?.at(-1)?.type === 'compaction_trigger'
export const summaryRequest = (request) => {
  const text = inspectRequest(request).lastUserText
  return (
    text.includes('<conversation>') || text.includes('earlier context from an ongoing conversation')
  )
}
export const ordinaryRequest = (request) =>
  request.method === 'POST' && !nativeRequest(request) && !summaryRequest(request)
export const checkpointItems = (request) =>
  request.body?.input?.filter((item) => item.type === 'compaction') ?? []

const ACCOUNT = 'acct-native-compaction-qa'
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const TOKEN = [
  encode({ alg: 'none' }),
  encode({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } }),
  'qa-signature'
].join('.')

/** All engine accounts, sessions, workspaces and credentials here are disposable fixtures. */
export async function compactionFixture(engine, subscription, externalServer) {
  const fixture = await createEngineFixture()
  let app
  try {
    const server = externalServer ?? (engine === 'pi' ? fixture.piServer : fixture.primeServer)
    const provider =
      (engine === 'prime' && subscription) || subscription === 'codex' ? 'openai-codex' : 'openai'
    const api = provider === 'openai-codex' ? 'openai-codex-responses' : 'openai-responses'
    const directory = engine === 'pi' ? fixture.piDirectory.dir : fixture.primeDirectory
    const model = {
      id: MODEL,
      name: MODEL,
      api,
      baseUrl: server.openaiBaseUrl,
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max'
      },
      input: ['text'],
      contextWindow: 272000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    await writeFile(
      join(directory, 'models.json'),
      JSON.stringify({
        providers: {
          [provider]: {
            api,
            baseUrl: server.openaiBaseUrl,
            ...(subscription ? {} : { apiKey: 'qa-local-proxy-key' }),
            models: [model]
          }
        }
      })
    )
    await writeFile(
      join(directory, 'auth.json'),
      JSON.stringify(
        subscription
          ? {
              [provider]: {
                type: 'oauth',
                access: TOKEN,
                refresh: 'qa-unused-refresh',
                expires: Date.now() + 86400000,
                accountId: ACCOUNT
              }
            }
          : {}
      )
    )
    const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        ...settings,
        defaultProvider: provider,
        defaultModel: MODEL,
        defaultThinkingLevel: 'low',
        compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 8192 },
        retry: { enabled: false },
        telemetry: { enabled: false }
      })
    )
    server.setAccountModels?.([MODEL])
    const workspace = await fixture.root.folder(`workspace-${engine}-${subscription}`, {
      'operands.txt': '17 19\n',
      'AGENTS.md':
        'Read operands.txt first. Use a separate tool call to save result.txt afterward. ' +
        'Then give a brief report.\n'
    })
    const packagedExecutable = process.env.QA_PACKAGED_EXE
    app = await launchApp({
      exe: packagedExecutable,
      agentDir: fixture.piDirectory.dir,
      env: {
        ...fixture.environment,
        ...(packagedExecutable
          ? { VENGEANCE_PRIME_EXECUTABLE: undefined, VENGEANCE_BUNDLED_ENGINES: undefined }
          : {})
      },
      outDir: reportShotsDir('native-compaction')
    })
    if (packagedExecutable) {
      assert.equal(await app.app.evaluate(({ app: application }) => application.isPackaged), true)
      assert.equal((await app.invoke('engine:describe', engine)).source, 'bundled')
    }
    const { agentId } = await app.openWorkspace({
      cwd: workspace,
      args: { engine, provider, model: MODEL, thinking: 'low' }
    })
    await until(async () => (await app.agentState(agentId))?.status === 'ready', {
      label: `${engine} ready`,
      timeoutMs: 120000
    })
    return {
      app,
      agentId,
      server,
      workspace,
      provider,
      async close() {
        try {
          await app.close({ beforeCleanup: fixture.stopNativeDaemon })
        } finally {
          await fixture.cleanup()
        }
      }
    }
  } catch (error) {
    await app?.close({ beforeCleanup: fixture.stopNativeDaemon })
    await fixture.cleanup()
    throw error
  }
}

export async function verifyFinishedTask(test) {
  const { app, agentId, server, workspace } = test
  await app.waitForSettle({ timeoutMs: 180000 })
  const { messages } = await app.rpc({ type: 'get_messages' }, agentId)
  const text =
    messages
      .filter((message) => message.role === 'assistant')
      .at(-1)
      ?.content?.filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('') ?? ''
  assert.match(text, /323/, 'the model must give the task report after compaction')
  assert.doesNotMatch(text, /^\s*OK[.!]?\s*$/i)
  assert.equal((await readFile(join(workspace, 'result.txt'), 'utf8')).trim(), '323')
  const native = server.requests.find(nativeRequest)
  assert.ok(native, 'the task crossed a native compaction')
  assert.equal(native.body.max_output_tokens, undefined)
  assert.equal(native.body.reasoning, undefined, 'compaction uses provider reasoning defaults')
  assert.ok(native.body.tools?.length, 'checkpoint includes the active tools')
  assert.doesNotMatch(JSON.stringify(native.body.input), /Reply with OK only|Checkpoint:/)
  const resumed = server.requests.find(
    (request) =>
      request.index > native.index &&
      ordinaryRequest(request) &&
      checkpointItems(request).length === 1
  )
  assert.ok(resumed, 'the engine actually resumed from the opaque checkpoint')
  assert.equal(
    messages.filter(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes(TASK)
    ).length <= 1,
    true
  )
  assert.equal((await app.agentState(agentId)).lastCompaction?.aborted, false)
  return { report: text, nativeIndex: native.index, resumedIndex: resumed.index }
}
