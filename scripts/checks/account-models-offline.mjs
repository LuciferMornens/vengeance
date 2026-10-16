// Work offline and the ChatGPT account's model list (needs `npm run build`, or `--exe <packaged exe>`): with Work
// offline on, a launch with a stale list reads nothing (no GET /v1/models past the boot check) and keeps showing the
// last list; turning Work offline off reads the list again.
//
//   node scripts/checks/account-models-offline.mjs [--exe release/qa/win-unpacked/VengeanceQA.exe]
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_API_KEY, FAKE_PROVIDER, createAgentDir, defaultFakeModels } from '../qa/lib/agent-dir.mjs'
import { launchApp } from '../qa/lib/app.mjs'
import { API, startFakeLlm } from '../qa/lib/fake-llm.mjs'
import { waitUntil } from '../qa/auth/helpers.mjs'

const OFFERED = ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-terra']
const OFFERED_KEYS = ['openai/gpt-5.6-terra', 'openai/gpt-6-luna', 'openai/gpt-6-sol']
/** Past the boot check (ACCOUNT_MODELS_FIRST_CHECK_MS, 4 s) with room for a slow start. */
const BOOT_CHECK_WAIT_MS = 8_000

const exeIndex = process.argv.indexOf('--exe')
const exe = exeIndex === -1 ? undefined : process.argv[exeIndex + 1]
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
/** The list main keeps in userData; null while missing or mid-write. */
function readList(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const modelListRequests = (server) =>
  server.requests.filter((request) => request.method === 'GET' && request.path === '/v1/models')
const openaiKeys = async (app) =>
  (await app.invoke('settings:catalog')).models
    .filter((model) => model.provider === 'openai')
    .map((model) => `${model.provider}/${model.id}`)
    .sort()

const server = await startFakeLlm()
const agentDir = await createAgentDir({ server })
let app
try {
  server.setAccountModels(OFFERED)
  await agentDir.writeText('models.json', {
    providers: {
      [FAKE_PROVIDER]: {
        name: 'QA Fake',
        baseUrl: server.anthropicBaseUrl,
        api: API.anthropic,
        apiKey: FAKE_API_KEY,
        models: defaultFakeModels(server)
      },
      openai: { baseUrl: server.openaiBaseUrl }
    }
  })
  await agentDir.writeText('auth.json', {
    openai: { type: 'oauth', access: 'qa-access', refresh: 'qa-refresh', expires: Date.now() + 86_400_000 }
  })

  app = await launchApp({ agentDir: agentDir.dir, exe })
  const cacheFile = join(app.userData, 'account-models.json')
  await waitUntil(() => modelListRequests(server).length > 0, { label: 'the boot read of the account list' })
  await waitUntil(() => readList(cacheFile)?.ids, { label: 'account-models.json' })
  await app.invoke('updates:set-offline', true)
  // A stale list: the next launch's boot check is due.
  writeFileSync(cacheFile, JSON.stringify({ ids: OFFERED, fetchedAt: 0 }))
  app = await app.relaunch()
  const before = modelListRequests(server).length
  await sleep(BOOT_CHECK_WAIT_MS)
  assert.equal(modelListRequests(server).length, before, 'no account read while Work offline is on')
  assert.deepEqual(await openaiKeys(app), OFFERED_KEYS, 'the last list still applies')
  console.log('PASS Work offline: a launch with a stale list reads nothing and keeps the last list')

  await app.invoke('updates:set-offline', false)
  await waitUntil(() => modelListRequests(server).length > before, { label: 'the read after going online' })
  await waitUntil(() => readList(cacheFile)?.fetchedAt > 0, { label: 'a fresh list' })
  console.log('PASS turning Work offline off reads the account list again')
} finally {
  await app?.close().catch(() => undefined)
  await server.close()
  await agentDir.cleanup().catch(() => undefined)
}
