import { strict as assert } from 'node:assert'
import { DEFAULT_APP_STATE, type AppPersistedState } from '../../src/shared/api/app'
import type { AgentInfo } from '../../src/shared/api/engine'
import {
  isSealed,
  maskAgentInfo,
  maskPrefs,
  openPrefs,
  resolveLaunchEnv,
  resolvePrefsPatch,
  revealWorkspaceEnv,
  sealPrefs,
  type EnvCipher
} from '../../src/main/features/launch/env-vault'
import { check } from './harness'

/** Reversible stand-in for safeStorage (Electron's DPAPI cipher is only available inside the app). */
const cipher: EnvCipher = {
  encrypt: (plain) => Buffer.from(`x${plain}`, 'utf8').toString('base64'),
  decrypt: (sealed) => {
    const text = Buffer.from(sealed, 'base64').toString('utf8')
    if (!text.startsWith('x')) throw new Error('cannot decrypt')
    return text.slice(1)
  }
}

const KEY = 'qa-test-value'
const ws = process.platform === 'win32' ? 'D:\\proj' : '/proj'
const prefs: AppPersistedState = {
  ...DEFAULT_APP_STATE,
  features: {
    launch: {
      workspaces: {
        [ws]: {
          offline: true,
          env: { OPENROUTER_API_KEY: KEY, PI_CACHE_RETENTION: 'long', EMPTY: '' }
        }
      }
    }
  }
}
const envOf = (state: AppPersistedState) => state.features.launch!.workspaces![ws]!.env!

await check(
  'env vault (N17): values are sealed at rest and open again; plain legacy values migrate',
  () => {
    const sealed = sealPrefs(prefs, cipher)
    for (const value of Object.values(envOf(sealed))) assert.equal(isSealed(value), true)
    assert.equal(JSON.stringify(sealed).includes(KEY), false)
    assert.equal(sealed.features.launch!.workspaces![ws]!.offline, true)
    const opened = openPrefs(sealed, cipher)
    assert.deepEqual(envOf(opened.prefs), envOf(prefs))
    assert.equal(opened.migrate, false)
    assert.equal(openPrefs(prefs, cipher).migrate, true)
    // Without OS encryption the value stays as it is rather than being lost.
    assert.equal(
      envOf(sealPrefs(prefs, { ...cipher, encrypt: () => null })).OPENROUTER_API_KEY,
      KEY
    )
  }
)

await check(
  'env vault: values that cannot be opened stay sealed, are kept, and never reach an engine',
  () => {
    const sealed = sealPrefs(prefs, cipher)
    const foreign = openPrefs(sealed, {
      ...cipher,
      decrypt: () => {
        throw new Error('other account')
      }
    }).prefs
    assert.equal(isSealed(envOf(foreign).OPENROUTER_API_KEY!), true)
    assert.equal(
      envOf(sealPrefs(foreign, cipher)).OPENROUTER_API_KEY,
      envOf(sealed).OPENROUTER_API_KEY
    )
    const args = resolveLaunchEnv({ cwd: ws, launch: { env: { ...envOf(foreign) } } }, foreign)
    assert.equal(args.launch!.env!.OPENROUTER_API_KEY, undefined)
    assert.equal(revealWorkspaceEnv(foreign, ws, 'OPENROUTER_API_KEY'), null)
  }
)

await check(
  'env vault: the renderer only sees masks; unchanged masks resolve back, edits win',
  () => {
    const masked = envOf(maskPrefs(prefs))
    assert.equal(JSON.stringify(masked).includes(KEY), false)
    assert.equal(masked.PI_CACHE_RETENTION!.includes('long'), false)
    assert.equal(masked.EMPTY, '')
    const patch = resolvePrefsPatch(
      {
        features: {
          launch: {
            workspaces: { [ws]: { env: { ...masked, PI_CACHE_RETENTION: 'short', NEW: 'v' } } }
          }
        }
      },
      prefs
    )
    assert.deepEqual(patch.features!.launch!.workspaces![ws]!.env, {
      OPENROUTER_API_KEY: KEY,
      PI_CACHE_RETENTION: 'short',
      EMPTY: '',
      NEW: 'v'
    })
  }
)

await check(
  'env vault: engine spawns get real values; AgentInfo goes out masked; reveal is explicit',
  () => {
    const masked = envOf(maskPrefs(prefs))
    const other = process.platform === 'win32' ? 'd:/PROJ/' : '/proj/'
    const args = resolveLaunchEnv(
      {
        cwd: other,
        launch: { env: { OPENROUTER_API_KEY: masked.OPENROUTER_API_KEY!, SESSION_ONLY: 'x' } }
      },
      prefs
    )
    assert.deepEqual(args.launch!.env, { OPENROUTER_API_KEY: KEY, SESSION_ONLY: 'x' })
    const info: AgentInfo = {
      agentId: 'a',
      engine: 'pi',
      cwd: ws,
      status: 'ready',
      mock: false,
      busy: false,
      bridge: false,
      createdAt: 0,
      args
    }
    assert.equal(JSON.stringify(maskAgentInfo(info)).includes(KEY), false)
    assert.equal(info.args.launch!.env!.OPENROUTER_API_KEY, KEY)
    assert.equal(revealWorkspaceEnv(prefs, other, 'OPENROUTER_API_KEY'), KEY)
    assert.equal(revealWorkspaceEnv(prefs, other, 'MISSING'), null)
  }
)
