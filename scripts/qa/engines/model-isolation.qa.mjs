import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { packagedLaunchOptions, recordPackagedTarget } from '../lib/packaged-target.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { pickModelInFooter, pickThinkingLevel, until } from '../chat/helpers.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'
import { chooseSpeed, waitForPill } from './speed-mode-helpers.mjs'

const PARENT_NAME = 'Parent model isolation'
const CODEX_PROVIDER = 'openai-codex'
const CODEX_MODEL = 'gpt-6.1-sol'
const CHILD_NAME = 'Different model child'
const CHILD_PROMPT = 'Reply briefly for the model isolation child.'
const DELEGATION_PROMPT = 'Start the model isolation child.'
const KERNEL_TIMEOUT_MS = 120_000
const OAUTH_VALIDITY_MS = 86_400_000
const PRESERVED_SETTING = { futurePreference: 'keep this value' }
const fixture = await createEngineFixture()
let application
let failure

async function assertSelection(agentId, model, provider = PRIME_PROVIDER) {
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(state.model.provider, provider)
  assert.equal(state.model.id, model)
  return state
}

async function assertCodexSelection(agentId) {
  const state = await assertSelection(agentId, CODEX_MODEL, CODEX_PROVIDER)
  assert.equal(state.thinkingLevel, 'max')
  const session = await application.invoke('prime:command', agentId, 'get_session_context', {})
  assert.equal(session.context.serviceTier, 'priority')
  const rendered = await application.agentState(agentId)
  assert.equal(rendered.model.id, CODEX_MODEL)
  assert.equal(rendered.thinkingLevel, 'max')
  await waitForPill(application, 'Fast')
  return state
}

async function sendAndCheck(agentId, prompt, model, provider = PRIME_PROVIDER) {
  const from = fixture.primeServer.requests.length
  fixture.primeServer.queue(turn.text(`Finished ${prompt}`, { serviceTier: true }))
  await application.send(prompt)
  const request = await fixture.primeServer.waitForRequest((entry) => entry.method === 'POST', {
    from
  })
  assert.equal(await fixture.primeServer.waitForOutcome(request), 'completed')
  assert.equal(inspectRequest(request).model, model)
  await application.waitForSettle()
  await assertSelection(agentId, model, provider)
  if (provider === CODEX_PROVIDER) {
    assert.equal(request.body.service_tier, 'priority')
    assert.equal(request.body.reasoning.effort, 'max')
    await assertCodexSelection(agentId)
  }
}

async function configureAccount() {
  const modelsPath = join(fixture.primeDirectory, 'models.json')
  const models = JSON.parse(await readFile(modelsPath, 'utf8'))
  models.providers[CODEX_PROVIDER] = { baseUrl: fixture.primeServer.openaiBaseUrl }
  await writeFile(modelsPath, `${JSON.stringify(models)}\n`)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const accountId = 'qa-model-isolation'
  const token = `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId }
  })}.qa-signature`
  await writeFile(
    join(fixture.primeDirectory, 'auth.json'),
    JSON.stringify({
      [CODEX_PROVIDER]: {
        type: 'oauth',
        access: token,
        refresh: 'qa-refresh',
        expires: Date.now() + OAUTH_VALIDITY_MS,
        accountId
      }
    })
  )
  fixture.primeServer.setAccountModels([CODEX_MODEL], {
    serviceTiers: { [CODEX_MODEL]: [{ id: 'priority' }] }
  })
  const settingsPath = join(fixture.primeDirectory, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  await writeFile(settingsPath, JSON.stringify({ ...settings, pluginSetting: PRESERVED_SETTING }))
}

async function checkChild(agentId) {
  const server = fixture.primeServer
  const from = server.requests.length
  const isParent = (entry) => inspectRequest(entry).model === CODEX_MODEL
  const isChild = (entry) => inspectRequest(entry).model === PRIME_MODELS.small
  const childArguments = [
    JSON.stringify(CHILD_PROMPT),
    `name=${JSON.stringify(CHILD_NAME)}`,
    `model=${JSON.stringify(`${PRIME_PROVIDER}/${PRIME_MODELS.small}`)}`,
    'thinking="low"'
  ].join(', ')
  const code = [
    'import rlm',
    `child = await rlm.spawn(${childArguments})`,
    'print(child.rlm_child_id)'
  ].join('\n')
  server.queue(
    turn.toolCall('ipython', { code }, { when: isParent, serviceTier: true }),
    turn.text('Child finished on its selected model.', { when: isChild }),
    turn.text('Parent finished delegating.', { when: isParent, serviceTier: true })
  )
  await application.send(DELEGATION_PROMPT)
  const childRequest = await server.waitForRequest(isChild, { from, timeoutMs: KERNEL_TIMEOUT_MS })
  assert.equal(await server.waitForOutcome(childRequest), 'completed')
  const child = await until(
    async () => {
      const roster = await application.invoke('prime:command', agentId, 'get_rlm_children', {})
      return roster.children.find(
        (entry) => entry.sessionName === CHILD_NAME && entry.status === 'done'
      )
    },
    { label: 'different-model child finished', timeoutMs: KERNEL_TIMEOUT_MS }
  )
  assert.ok(child.activeSessionId)
  await application.waitForSettle({ timeoutMs: KERNEL_TIMEOUT_MS })
  await assertCodexSelection(agentId)
  const parentRequests = server.requests
    .slice(from)
    .filter((entry) => entry.method === 'POST' && !isChild(entry))
  assert.ok(parentRequests.length >= 2, 'parent requests before and after the child tool call')
  for (const request of parentRequests) {
    assert.equal(inspectRequest(request).model, CODEX_MODEL)
    assert.equal(request.body.service_tier, 'priority')
    assert.equal(request.body.reasoning.effort, 'max')
  }
}

try {
  await configureAccount()
  application = await launchApp({
    ...packagedLaunchOptions(fixture.environment),
    agentDir: fixture.piDirectory.dir,
    outDir: reportShotsDir('engine2-model-isolation')
  })
  await recordPackagedTarget(application)
  const workspace = await fixture.root.folder('workspace', { 'README.md': '# Model isolation\n' })
  const { agentId } = await application.openWorkspace({
    cwd: workspace,
    args: { engine: 'prime', name: PARENT_NAME }
  })
  await assertSelection(agentId, PRIME_MODELS.reasoning)
  await sendAndCheck(agentId, 'Initial parent turn', PRIME_MODELS.reasoning)
  console.log('PASS parent starts on its native default and serves it')

  const sibling = await application.openWorkspace({
    cwd: workspace,
    args: { engine: 'prime', name: 'Sibling model selection' }
  })
  await application.rpc(
    { type: 'set_model', provider: PRIME_PROVIDER, modelId: PRIME_MODELS.small },
    sibling.agentId
  )
  await assertSelection(sibling.agentId, PRIME_MODELS.small)
  await assertSelection(agentId, PRIME_MODELS.reasoning)
  const saved = JSON.parse(await readFile(join(fixture.primeDirectory, 'settings.json'), 'utf8'))
  assert.deepEqual(saved.pluginSetting, PRESERVED_SETTING)
  await application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: PARENT_NAME })
    .click()
  await sendAndCheck(agentId, 'Parent after sibling selection', PRIME_MODELS.reasoning)
  console.log('PASS sibling default changes cannot change the parent model or provider requests')
  await application.screenshot('parent-after-sibling-selection')

  const fresh = await application.openWorkspace({
    cwd: workspace,
    args: { engine: 'prime', name: 'New session uses new defaults' }
  })
  await assertSelection(fresh.agentId, PRIME_MODELS.small)
  await application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: PARENT_NAME })
    .click()
  console.log('PASS a fresh session still uses the latest native defaults')

  await pickModelInFooter(application, CODEX_PROVIDER, CODEX_MODEL)
  await pickThinkingLevel(application, 'max')
  await chooseSpeed(application, 'fast')
  await sendAndCheck(agentId, 'GPT 6.1 Sol Max Fast parent', CODEX_MODEL, CODEX_PROVIDER)
  await checkChild(agentId)
  console.log(
    'PASS child completion preserves GPT 6.1 Sol, Max, Fast in native state, UI and requests'
  )
  await application.screenshot('parent-after-child-completion')

  await application.rpc(
    { type: 'set_model', provider: PRIME_PROVIDER, modelId: PRIME_MODELS.reasoning },
    sibling.agentId
  )
  const before = await assertCodexSelection(agentId)
  await application.invoke('engine:restart', agentId, undefined)
  await until(async () => (await application.agentState(agentId))?.status === 'ready', {
    label: 'parent restarted'
  })
  const after = await assertCodexSelection(agentId)
  assert.equal(after.sessionId, before.sessionId)
  assert.equal(after.sessionFile, before.sessionFile)
  const history = await application.rpc({ type: 'get_messages' }, agentId)
  assert.ok(JSON.stringify(history).includes('Parent finished delegating.'))
  await sendAndCheck(agentId, 'Parent after restart', CODEX_MODEL, CODEX_PROVIDER)
  console.log(
    'PASS restart preserves parent model, reasoning, speed and history despite new defaults'
  )
  await application.screenshot('parent-after-restart')
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
}

if (failure) {
  console.error(failure)
  process.exitCode = 1
}
