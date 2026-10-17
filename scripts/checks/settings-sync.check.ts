import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject, SettingsSnapshot } from '@shared/api/settings'
import { findSetting, type SettingDef } from '@shared/api/settings-schema'
import {
  lastWrittenText,
  replaceJsonFile,
  updateJsonFile,
  writeFileAtomic
} from '../../src/main/features/settings/json-file'
import {
  keyConflicts,
  normalizeKey
} from '../../src/renderer/features/settings/sections/keybinding-conflicts'
import {
  changedSettings,
  liveSetting,
  restartsAfterOutsideEdit,
  settingEffect
} from '../../src/renderer/features/settings/values'
import { check } from './harness'

/** Keeping Settings and open engines in step with the files on disk (settings-2..12 fixes). */

const root = mkdtempSync(join(tmpdir(), 'vengeance-settings-sync-check-'))
const BROKEN = '{\n  "steeringMode": "all",\n'

await check(
  'json-file (settings-8): the text Vengeance wrote is remembered per file for the config watcher',
  async () => {
    const file = join(root, 'settings.json')
    assert.equal(lastWrittenText(file), undefined)
    await writeFileAtomic(file, '{ "a": 1 }\n')
    assert.equal(lastWrittenText(file), '{ "a": 1 }\n')
    writeFileSync(file, '{ "a": 2 }\n')
    assert.notEqual(
      readFileSync(file, 'utf8'),
      lastWrittenText(file),
      'an outside edit no longer matches'
    )
  }
)

await check(
  'json-file (settings-7): Raw JSON text replaces a corrupt file; key edits refuse it, naming only the file',
  async () => {
    const file = join(root, 'broken', 'settings.json')
    await replaceJsonFile(file, null, BROKEN)
    await assert.rejects(
      updateJsonFile(file, null, (current) => current),
      (error: Error) =>
        error.message.startsWith('settings.json is not valid JSON') && !error.message.includes(root)
    )
    assert.equal(readFileSync(file, 'utf8'), BROKEN, 'a refused edit leaves the file byte for byte')
    await replaceJsonFile(file, null, '{\n  "steeringMode": "all"\n}\n')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { steeringMode: 'all' })
  }
)

function snapshot(
  global: JsonObject,
  project?: { data: JsonObject; trusted: boolean }
): SettingsSnapshot {
  const file = (data: JsonObject) => ({
    path: 'settings.json',
    exists: true,
    data,
    text: JSON.stringify(data)
  })
  return {
    agentDir: root,
    global: file(global),
    project: project
      ? {
          ...file(project.data),
          cwd: 'C:/work/app',
          trust: { saved: project.trusted, fallback: 'ask', effective: project.trusted }
        }
      : null,
    isolated: true,
    envOverrides: {}
  }
}

const keysOf = (defs: Pick<SettingDef, 'key'>[]) => defs.map((def) => def.key)
const def = (key: string) => findSetting(key)!

await check(
  'changedSettings (settings-4): global and trusted project edits count, untrusted project edits do not',
  () => {
    const before = snapshot(
      { steeringMode: 'one-at-a-time', retry: { maxRetries: 3 } },
      { data: { thinkingBudgets: { low: 1 } }, trusted: false }
    )
    const after = snapshot(
      { steeringMode: 'all', retry: { maxRetries: 7 } },
      { data: { thinkingBudgets: { low: 2 } }, trusted: false }
    )
    assert.deepEqual(keysOf(changedSettings(before, after)).sort(), [
      'retry.maxRetries',
      'steeringMode'
    ])
    const trustedBefore = snapshot({}, { data: { thinkingBudgets: { low: 1 } }, trusted: true })
    const trustedAfter = snapshot({}, { data: { thinkingBudgets: { low: 2 } }, trusted: true })
    assert.deepEqual(keysOf(changedSettings(trustedBefore, trustedAfter)), ['thinkingBudgets.low'])
    assert.deepEqual(changedSettings(after, after), [])
  }
)

await check(
  'changedSettings: `defaultProvider` alone changes the Default model row (alsoKeys)',
  () => {
    assert.deepEqual(
      keysOf(
        changedSettings(snapshot({ defaultProvider: 'a' }), snapshot({ defaultProvider: 'b' }))
      ),
      ['defaultModel']
    )
  }
)

await check(
  'restartsAfterOutsideEdit: live, session-written and terminal-only keys never ask for a restart',
  () => {
    assert.equal(restartsAfterOutsideEdit(def('retry.maxRetries')), true)
    assert.equal(restartsAfterOutsideEdit(def('steeringMode')), false, 'applied live over RPC')
    assert.equal(
      restartsAfterOutsideEdit(def('defaultModel')),
      false,
      'a model switch in a session saves it'
    )
    assert.equal(restartsAfterOutsideEdit(def('defaultThinkingLevel')), false)
    assert.equal(restartsAfterOutsideEdit(def('quietStartup')), false, 'terminal UI only')
    assert.equal(
      restartsAfterOutsideEdit(def('hideThinkingBlock')),
      false,
      'Vengeance applies it instantly'
    )
  }
)

await check(
  'Prime settings classify native defaults, terminal preferences and request transport independently',
  () => {
    const before = snapshot({})
    const after = snapshot({
      defaultProvider: 'local',
      defaultModel: 'second',
      defaultThinkingLevel: 'high',
      defaultServiceTier: 'priority',
      recentModels: ['second'],
      transport: 'web-socket',
      theme: 'light',
      telemetry: { noticeShown: true },
      shellCommandPrefix: 'prefix'
    })
    const changed = changedSettings(before, after, 'prime', 'global')
    const restarts = changed.filter((def) => restartsAfterOutsideEdit(def, 'prime', 'global'))
    assert.deepEqual(keysOf(restarts), ['shellCommandPrefix'])
  }
)

await check(
  'Prime runtime toggles it saves itself apply live globally, while a project value takes a restart',
  () => {
    const before = snapshot({}, { data: {}, trusted: true })
    const toggled = { compaction: { enabled: false }, retry: { enabled: false }, rlmMaxDepth: 3 }
    const after = snapshot(toggled, { data: {}, trusted: true })
    const global = changedSettings(before, after, 'prime', 'global')
    assert.deepEqual(keysOf(global).sort(), ['compaction.enabled', 'retry.enabled', 'rlmMaxDepth'])
    assert.deepEqual(global.filter((def) => restartsAfterOutsideEdit(def, 'prime', 'global')), [])
    const live = global.map((def) => liveSetting(def, 'prime', 'global')).filter(Boolean)
    assert.deepEqual(live.sort(), ['autoCompaction', 'autoRetry'])
    // Engine 2 saves an applied toggle as the global value, so a project's own value never goes over RPC.
    const edited = snapshot({}, { data: toggled, trusted: true })
    const project = changedSettings(before, edited, 'prime', 'project')
    const restarts = project.filter((def) => restartsAfterOutsideEdit(def, 'prime', 'project'))
    assert.deepEqual(keysOf(restarts).sort(), ['compaction.enabled', 'retry.enabled'])
    assert.equal(liveSetting(def('compaction.enabled'), 'pi', 'project'), 'autoCompaction')
  }
)

await check(
  'settings comparisons ignore object key order and isolate the changed file scope',
  () => {
    const before = snapshot(
      { compaction: { modelOverrides: { first: { enabled: true, reserveTokens: 100 } } } },
      { data: { shellCommandPrefix: 'first' }, trusted: true }
    )
    const after = snapshot(
      { compaction: { modelOverrides: { first: { reserveTokens: 100, enabled: true } } } },
      { data: { shellCommandPrefix: 'second' }, trusted: true }
    )
    assert.deepEqual(changedSettings(before, after, 'pi', 'global'), [])
    assert.deepEqual(keysOf(changedSettings(before, after, 'prime', 'project')), [
      'shellCommandPrefix'
    ])
    assert.deepEqual(changedSettings(before, after, 'prime', 'global'), [])
  }
)

await check(
  'Prime null settings inherit, while clearing an explicit startup value still restarts',
  () => {
    const absent = snapshot({}, { data: {}, trusted: true })
    const unset = snapshot(
      { shellPath: null, telemetry: { enabled: null, localMirror: null } },
      {
        data: { shellCommandPrefix: null, retry: { maxRetries: null } },
        trusted: true
      }
    )
    assert.deepEqual(changedSettings(absent, unset, 'prime'), [])
    assert.deepEqual(changedSettings(unset, absent, 'prime'), [])
    const configured = snapshot(
      { shellPath: 'shell.exe' },
      {
        data: { shellCommandPrefix: 'prefix' },
        trusted: true
      }
    )
    assert.deepEqual(keysOf(changedSettings(configured, unset, 'prime', 'global')), ['shellPath'])
    assert.deepEqual(keysOf(changedSettings(configured, unset, 'prime', 'project')), [
      'shellCommandPrefix'
    ])
    assert.deepEqual(keysOf(changedSettings(absent, unset, 'pi', 'global')), ['shellPath'])
  }
)

await check(
  'settingEffect (ext-7): the terminal theme also colors HTML exports, so sessions restart for it',
  () => {
    assert.equal(settingEffect(def('theme')), 'restart')
    assert.equal(settingEffect(def('quietStartup')), 'none')
    assert.equal(settingEffect(def('doubleEscapeAction')), 'none')
  }
)

await check('normalizeKey (settings-10): modifier order and key aliases do not matter', () => {
  assert.equal(normalizeKey('alt+shift+n'), 'shift+alt+n')
  assert.equal(normalizeKey('Shift+Alt+N'), 'shift+alt+n')
  assert.equal(normalizeKey('super+ctrl+k'), 'ctrl+super+k')
  assert.equal(normalizeKey('esc'), 'escape')
  assert.equal(normalizeKey('ctrl+return'), 'ctrl+enter')
  assert.equal(normalizeKey('ctrl++'), 'ctrl++')
})

await check(
  'keyConflicts (settings-10): user/user and user/default clashes, never overlaps the defaults ship with',
  () => {
    const actions = [
      { id: 'app.session.new', description: 'Start a new session', group: 'Session', defaults: [] },
      { id: 'app.session.tree', description: 'Open session tree', group: 'Session', defaults: [] },
      {
        id: 'app.session.fork',
        description: 'Fork current session',
        group: 'Session',
        defaults: []
      },
      {
        id: 'app.message.dequeue',
        description: 'Restore queued messages',
        group: 'Messages',
        defaults: ['alt+q']
      },
      { id: 'tui.select.up', description: 'Move selection up', group: 'Lists', defaults: ['up'] },
      {
        id: 'tui.editor.cursorUp',
        description: 'Move cursor up',
        group: 'Editor',
        defaults: ['up']
      }
    ]
    assert.deepEqual([...keyConflicts(actions, {})], [], 'shared defaults are intentional')
    const conflicts = keyConflicts(actions, {
      'app.session.new': ['shift+alt+n'],
      'app.session.tree': ['alt+shift+n'],
      'app.session.fork': ['alt+q'],
      'tui.editor.cursorUp': ['up', 'alt+u']
    })
    assert.deepEqual(conflicts.get('app.session.new'), ['app.session.tree'])
    assert.deepEqual(conflicts.get('app.session.tree'), ['app.session.new'])
    assert.deepEqual(conflicts.get('app.session.fork'), ['app.message.dequeue'])
    assert.deepEqual(conflicts.get('app.message.dequeue'), ['app.session.fork'])
    assert.equal(
      conflicts.has('tui.editor.cursorUp'),
      false,
      'keeping a default key is no new conflict'
    )
  }
)

rmSync(root, { recursive: true, force: true })
