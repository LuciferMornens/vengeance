import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import {
  engineSettings,
  PRIME_HEADER_VALUE,
  PRIME_PROVIDER,
  storeApiKey
} from './integration-fixture.mjs'

const SAVED_API_KEYS = { pi: 'qa-pi-auth-only', prime: 'qa-prime-auth-only' }

function samePath(actual, expected) {
  return resolve(actual).toLowerCase() === resolve(expected).toLowerCase()
}

function transcriptText(state) {
  return JSON.stringify(state.entries.map((entry) => entry.message))
}

export async function checkEngineConfiguration(application, fixture, workspace, agentId, check) {
  await check(
    'settings writes and provider catalogs stay inside each engine directory',
    async () => {
      const piSnapshot = await engineSettings(application, 'pi', 'settings:snapshot', workspace)
      const primeSnapshot = await engineSettings(
        application,
        'prime',
        'settings:snapshot',
        workspace
      )
      assert.ok(samePath(piSnapshot.agentDir, fixture.piDirectory.dir))
      assert.ok(samePath(primeSnapshot.agentDir, fixture.primeDirectory))
      assert.ok(
        samePath(primeSnapshot.project.path, join(workspace, '.prime', 'agent', 'settings.json'))
      )
      const piSettingsBefore = await fixture.piDirectory.readText('settings.json')
      await engineSettings(application, 'prime', 'settings:set', {
        scope: 'global',
        cwd: workspace,
        path: ['defaultThinkingLevel'],
        value: 'low'
      })
      assert.equal(await fixture.piDirectory.readText('settings.json'), piSettingsBefore)
      const primeSettingsBefore = await readFile(
        join(fixture.primeDirectory, 'settings.json'),
        'utf8'
      )
      await engineSettings(application, 'pi', 'settings:set', {
        scope: 'global',
        cwd: workspace,
        path: ['defaultThinkingLevel'],
        value: 'medium'
      })
      assert.equal(
        await readFile(join(fixture.primeDirectory, 'settings.json'), 'utf8'),
        primeSettingsBefore
      )
      const engineCatalog = await engineSettings(application, 'pi', 'settings:catalog')
      const primeCatalog = await engineSettings(application, 'prime', 'settings:catalog')
      assert.ok(engineCatalog.providers.some((provider) => provider.id === FAKE_PROVIDER))
      assert.ok(!engineCatalog.providers.some((provider) => provider.id === PRIME_PROVIDER))
      assert.ok(primeCatalog.providers.some((provider) => provider.id === PRIME_PROVIDER))
      assert.ok(!primeCatalog.providers.some((provider) => provider.id === FAKE_PROVIDER))
    }
  )

  await check('literal native model headers stay out of renderer IPC responses', async () => {
    const models = JSON.parse(await readFile(join(fixture.primeDirectory, 'models.json'), 'utf8'))
    assert.equal(
      models.providers[PRIME_PROVIDER].models[0].headers.Authorization,
      PRIME_HEADER_VALUE
    )
    const before = transcriptText(await application.agentState(agentId))
    const requests = [
      () => engineSettings(application, 'prime', 'settings:catalog'),
      () => engineSettings(application, 'prime', 'settings:models-json'),
      () => application.rpc({ type: 'get_available_models' }, agentId),
      () => application.rpc({ type: 'get_state' }, agentId),
      () => application.invoke('prime:command', agentId, 'get_model_catalog', {}),
      () => application.invoke('prime:command', agentId, 'get_state', {}),
      () =>
        application.invoke('prime:command', agentId, 'set_service_tier', { serviceTier: 'default' })
    ]
    for (const request of requests) {
      const response = await request()
      assert.ok(
        !JSON.stringify(response).includes(PRIME_HEADER_VALUE),
        'IPC exposed the fake Authorization marker'
      )
    }
    assert.equal(transcriptText(await application.agentState(agentId)), before)
  })

  await check('model edits preserve secret masks and do not change the other backend', async () => {
    const piModelsBefore = await fixture.piDirectory.readText('models.json')
    const primeModels = await engineSettings(application, 'prime', 'settings:models-json')
    assert.ok(primeModels.data.providers[PRIME_PROVIDER].apiKey.startsWith('••••'))
    primeModels.data.providers[PRIME_PROVIDER].models[0].name = 'Engine2 QA Renamed'
    await engineSettings(application, 'prime', 'settings:models-json-write', primeModels.data)
    assert.equal(await fixture.piDirectory.readText('models.json'), piModelsBefore)
    const primeModelsBefore = await readFile(join(fixture.primeDirectory, 'models.json'), 'utf8')
    const engineModels = await engineSettings(application, 'pi', 'settings:models-json')
    engineModels.data.providers[FAKE_PROVIDER].models[0].name = 'Engine QA Renamed'
    await engineSettings(application, 'pi', 'settings:models-json-write', engineModels.data)
    assert.equal(
      await readFile(join(fixture.primeDirectory, 'models.json'), 'utf8'),
      primeModelsBefore
    )
  })

  await check(
    'explicit API-key saves write separate auth files and expose masked hints',
    async () => {
      await storeApiKey(application, 'pi', FAKE_PROVIDER, SAVED_API_KEYS.pi)
      const piAuthBefore = await fixture.piDirectory.readText('auth.json')
      await storeApiKey(application, 'prime', PRIME_PROVIDER, SAVED_API_KEYS.prime)
      assert.equal(await fixture.piDirectory.readText('auth.json'), piAuthBefore)
      const primeAuth = JSON.parse(
        await readFile(join(fixture.primeDirectory, 'auth.json'), 'utf8')
      )
      const piAuth = await fixture.piDirectory.readJson('auth.json')
      assert.equal(primeAuth[PRIME_PROVIDER].key, SAVED_API_KEYS.prime)
      assert.equal(piAuth[FAKE_PROVIDER].key, SAVED_API_KEYS.pi)
      assert.ok(!Object.hasOwn(primeAuth, FAKE_PROVIDER))
      assert.ok(!Object.hasOwn(piAuth, PRIME_PROVIDER))
      const catalog = await engineSettings(application, 'prime', 'settings:catalog')
      assert.ok(!JSON.stringify(catalog).includes(SAVED_API_KEYS.prime))
      assert.ok(catalog.providers.find((provider) => provider.id === PRIME_PROVIDER).stored.hint)
    }
  )

  await check(
    'native resources honor nested ignore rules and toggle only native project settings',
    async () => {
      const resourceWorkspace = await fixture.root.folder(join('resource-scope', 'workspace'))
      await fixture.root.folder(join('resource-scope', '.agents', 'skills'), {
        '.ignore': 'hidden/\n',
        [join('visible', 'SKILL.md')]:
          '---\nname: qa-native-visible\ndescription: Isolated QA skill\n---\n# Native QA\n',
        [join('hidden', 'SKILL.md')]:
          '---\nname: qa-native-hidden\ndescription: Ignored QA skill\n---\n# Hidden\n'
      })
      const groups = await engineSettings(
        application,
        'prime',
        'settings:resources',
        resourceWorkspace
      )
      const items = groups.flatMap((group) => group.items)
      const visiblePath = fixture.root.path(
        'resource-scope',
        '.agents',
        'skills',
        'visible',
        'SKILL.md'
      )
      const hiddenPath = fixture.root.path(
        'resource-scope',
        '.agents',
        'skills',
        'hidden',
        'SKILL.md'
      )
      const visible = items.find((item) => samePath(item.path, visiblePath))
      assert.ok(visible, 'the native ancestor skill is listed')
      assert.ok(!items.some((item) => samePath(item.path, hiddenPath)))
      const piSettingsBefore = await fixture.piDirectory.readText('settings.json')
      const toggled = await engineSettings(application, 'prime', 'settings:resource-toggle', {
        cwd: resourceWorkspace,
        item: visible,
        enabled: false
      })
      assert.equal(
        toggled.flatMap((group) => group.items).find((item) => samePath(item.path, visible.path))
          .enabled,
        false
      )
      assert.equal(await fixture.piDirectory.readText('settings.json'), piSettingsBefore)
    }
  )
}
