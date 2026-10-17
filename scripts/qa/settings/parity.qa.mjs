// Settings parity: every key of the Engine's settings reference (docs/settings.md, the `Settings`
// type in dist/core/settings-manager.d.ts, and SettingsManager defaults) against Vengeance's schema
// (src/shared/api/settings-schema.ts): exposed or not, where, default, and global-only scope.
// No app is launched. `--markdown` prints the parity table used in reports/qa/settings.md.
//
//   node scripts/qa/settings/parity.qa.mjs [--markdown]
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from '../lib/app.mjs'
import { enginePackageDir, importEngine } from './engine-sdk.mjs'

// Bundled with esbuild (like scripts/checks): the schema's extensionless relative imports
// (`./settings-terminal`) do not resolve under Node's own type stripping.
const schemaBundle = await build({
  entryPoints: [join(ROOT, 'src', 'shared', 'api', 'settings-schema.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  logLevel: 'warning'
})
const { SETTINGS } = await import(
  `data:text/javascript;base64,${Buffer.from(schemaBundle.outputFiles[0].contents).toString('base64')}`
)
const { SettingsManager } = await importEngine('core/settings-manager.js')
const engine = SettingsManager.inMemory({})

const SECTION_LABELS = {
  models: 'Models',
  agent: 'Agent behavior',
  sessions: 'Sessions & context',
  packages: 'Packages',
  resources: 'Resources',
  terminal: 'Terminal mode'
}

/** Engine-side defaults straight from SettingsManager getters (undefined = resolved elsewhere). */
const SDK_DEFAULTS = {
  defaultThinkingLevel: () => engine.getDefaultThinkingLevel(),
  hideThinkingBlock: () => engine.getHideThinkingBlock(),
  showCacheMissNotices: () => engine.getShowCacheMissNotices(),
  cacheWarming: () => engine.getCacheWarmingMode(),
  steeringMode: () => engine.getSteeringMode(),
  followUpMode: () => engine.getFollowUpMode(),
  doubleEscapeAction: () => engine.getDoubleEscapeAction(),
  treeFilterMode: () => engine.getTreeFilterMode(),
  defaultProjectTrust: () => engine.getDefaultProjectTrust(),
  'compaction.enabled': () => engine.getCompactionSettings().enabled,
  'compaction.reserveTokens': () => engine.getCompactionSettings().reserveTokens,
  'compaction.keepRecentTokens': () => engine.getCompactionSettings().keepRecentTokens,
  'branchSummary.reserveTokens': () => engine.getBranchSummarySettings().reserveTokens,
  'branchSummary.skipPrompt': () => engine.getBranchSummarySettings().skipPrompt,
  quietStartup: () => engine.getQuietStartup(),
  tuiMode: () => engine.getTuiMode(),
  fullscreenExitOutput: () => engine.getFullscreenExitOutput(),
  fullscreenScrollbar: () => engine.getFullscreenScrollbar(),
  fullscreenCopyOnSelect: () => engine.getFullscreenCopyOnSelect(),
  fullscreenWheelScrollLines: () => engine.getFullscreenWheelScrollLines(),
  editorPaddingX: () => engine.getEditorPaddingX(),
  outputPad: () => engine.getOutputPad(),
  autocompleteMaxVisible: () => engine.getAutocompleteMaxVisible(),
  showHardwareCursor: () => engine.getShowHardwareCursor(),
  'terminal.showImages': () => engine.getShowImages(),
  'terminal.imageWidthCells': () => engine.getImageWidthCells(),
  'terminal.clearOnShrink': () => engine.getClearOnShrink(),
  'terminal.showTerminalProgress': () => engine.getShowTerminalProgress(),
  'images.autoResize': () => engine.getImageAutoResize(),
  'images.blockImages': () => engine.getBlockImages(),
  'markdown.codeBlockIndent': () => engine.getCodeBlockIndent(),
  'markdown.mermaid': () => engine.getMermaidRenderingMode(),
  transport: () => engine.getTransport(),
  httpIdleTimeoutMs: () => engine.getHttpIdleTimeoutMs(),
  'retry.enabled': () => engine.getRetrySettings().enabled,
  'retry.maxRetries': () => engine.getRetrySettings().maxRetries,
  'retry.baseDelayMs': () => engine.getRetrySettings().baseDelayMs,
  'retry.maxAgentDelayMs': () => engine.getRetrySettings().maxAgentDelayMs,
  'retry.provider.maxRetryDelayMs': () => engine.getProviderRetrySettings().maxRetryDelayMs,
  enableSkillCommands: () => engine.getEnableSkillCommands(),
  collapseChangelog: () => engine.getCollapseChangelog(),
  enableInstallTelemetry: () => engine.getEnableInstallTelemetry(),
  enableAnalytics: () => engine.getEnableAnalytics()
}

/** Internal bookkeeping keys of the `Settings` type that are not user settings. */
const INTERNAL_KEYS = new Set(['lastChangelogVersion', 'trackingId', 'deviceId'])

/** `| \`key\` | type | default | description |` rows of docs/settings.md, with the section heading. */
async function documentedSettings() {
  const text = await readFile(join(enginePackageDir(), 'docs', 'settings.md'), 'utf8')
  const rows = []
  let heading = ''
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) heading = line.replace(/^#+\s*/, '')
    const match = line.match(/^\| `([\w.]+)` \| (.+?) \| (.+?) \| (.+) \|$/)
    if (match) {
      const [, key, type, defaultText, description] = match
      const globalOnly = /Global setting only|only be set in agent-directory settings/i.test(
        description
      )
      rows.push({ key, type, defaultText, description, heading, globalOnly })
    }
  }
  return rows
}

/** Top-level keys of `export interface Settings` in the installed d.ts. */
async function typedTopLevelKeys() {
  const dts = await readFile(
    join(enginePackageDir(), 'dist', 'core', 'settings-manager.d.ts'),
    'utf8'
  )
  const body = dts.slice(dts.indexOf('export interface Settings {'))
  const block = body.slice(0, body.indexOf('\n}'))
  return [...block.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1])
}

/** A docs default like `"medium"`, `false`, `3000` → JSON value; prose defaults → undefined. */
function literal(defaultText) {
  const match = defaultText.match(/^`(.+)`$/)
  if (!match) return undefined
  try {
    return JSON.parse(match[1])
  } catch {
    return undefined
  }
}

const show = (value) => (value === undefined ? '—' : `\`${JSON.stringify(value)}\``)
const findSetting = (key) => SETTINGS.find((s) => s.key === key || s.alsoKeys?.includes(key))

const docs = await documentedSettings()
const rows = []
const problems = []
for (const doc of docs) {
  const subKeys = SETTINGS.filter((s) => s.key.startsWith(`${doc.key}.`))
  const setting = findSetting(doc.key)
  const docDefault = literal(doc.defaultText)
  const sdk = SDK_DEFAULTS[doc.key]?.()
  const where = setting
    ? `${SECTION_LABELS[setting.section] ?? setting.section} › ${setting.label}${setting.key !== doc.key ? ` (with \`${setting.key}\`)` : ''}`
    : subKeys.length
      ? `${SECTION_LABELS[subKeys[0].section]} › ${subKeys.map((s) => s.label).join(', ')}`
      : 'not exposed'
  const appDefault = setting
    ? setting.default !== undefined
      ? show(setting.default)
      : (setting.defaultLabel ?? '—')
    : subKeys.length
      ? 'per key'
      : '—'
  const notes = []
  if (!setting && !subKeys.length) notes.push('missing in Vengeance')
  // List settings show an empty list instead of a `[]` default.
  const emptyList =
    Array.isArray(docDefault) && docDefault.length === 0 && setting?.default === undefined
  if (setting && setting.key === doc.key && docDefault !== undefined && !emptyList) {
    if (JSON.stringify(setting.default) !== JSON.stringify(docDefault))
      notes.push('default differs from docs')
  }
  if (
    setting &&
    sdk !== undefined &&
    setting.key === doc.key &&
    JSON.stringify(setting.default) !== JSON.stringify(sdk)
  ) {
    notes.push('default differs from SDK')
  }
  if (
    docDefault !== undefined &&
    sdk !== undefined &&
    JSON.stringify(docDefault) !== JSON.stringify(sdk)
  ) {
    notes.push('Engine docs and SDK disagree')
  }
  if (setting && Boolean(setting.globalOnly) !== doc.globalOnly)
    notes.push('global-only scope differs')
  for (const note of notes) problems.push(`${doc.key}: ${note}`)
  rows.push({
    key: doc.key,
    docDefault: doc.defaultText,
    sdk: show(sdk),
    where,
    appDefault,
    scope: doc.globalOnly
      ? setting?.globalOnly
        ? 'global only (both)'
        : 'global only (Engine)'
      : 'global + project',
    status: notes.length ? notes.join('; ') : 'match'
  })
}

const documented = new Set(docs.map((d) => d.key))
const reverse = SETTINGS.filter(
  (s) =>
    !documented.has(s.key) &&
    !s.alsoKeys?.some((k) => documented.has(k)) &&
    !documented.has(s.key.split('.')[0])
)
const typed = (await typedTopLevelKeys()).filter((key) => !INTERNAL_KEYS.has(key))
const undocumentedTyped = typed.filter(
  (key) => !documented.has(key) && ![...documented].some((d) => d.startsWith(`${key}.`))
)

if (process.argv.includes('--markdown')) {
  console.log(
    '| Key | Engine default (docs) | Engine default (SDK getter) | Vengeance control | Vengeance default | Scope | Status |'
  )
  console.log('|---|---|---|---|---|---|---|')
  for (const r of rows) {
    console.log(
      `| \`${r.key}\` | ${r.docDefault} | ${r.sdk} | ${r.where} | ${r.appDefault} | ${r.scope} | ${r.status} |`
    )
  }
  console.log(
    `\nSchema keys the Engine docs do not list: ${reverse.map((s) => `\`${s.key}\``).join(', ') || 'none'}`
  )
  console.log(
    `Typed Settings keys missing from the docs: ${undocumentedTyped.map((k) => `\`${k}\``).join(', ') || 'none'}`
  )
} else {
  console.log(`▶ settings-parity (${docs.length} documented keys, ${SETTINGS.length} schema rows)`)
  try {
    assert.ok(docs.length > 60, `parsed only ${docs.length} rows of docs/settings.md`)
    assert.deepEqual(problems, [], 'Engine/Vengeance parity')
    assert.deepEqual(
      reverse.map((s) => s.key),
      [],
      'Vengeance controls for keys the Engine does not document'
    )
    assert.deepEqual(undocumentedTyped, [], 'typed Settings keys without docs')
    console.log('✓ settings-parity passed')
  } catch (error) {
    console.error(`  ✗ ${error.message}`)
    console.error('✗ settings-parity failed')
    process.exitCode = 1
  }
}
