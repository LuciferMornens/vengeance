import { shell } from 'electron'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type {
  ContextOverview,
  InstructionFileRef,
  InstructionFileState,
  JsonObject,
  KeybindingsState,
  SetSettingArgs,
  SettingsSnapshot,
  TextTail,
  ValidationIssue,
  WriteRawSettingsArgs
} from '@shared/api/settings'
import {
  errorCode,
  jsonObject,
  jsonStrings,
  mergePrimeSettings,
  parsePrimeJson,
  primeProjectDir,
  primeSettingsPath,
  readPrimeJson,
  restorePrimeSecrets,
  safePrimeFileState,
  setPrimeValue,
  updatePrimeJson,
  writePrimeText
} from './configuration-store'
import { getPrimeAgentDir } from './locate'
import { primeSessionRoot } from './sessions'
import { primeKeybindingActions } from './configuration-keybindings'
import { assertPrimeFactoryChange } from './configuration-factory'

const INSTRUCTION_KINDS = new Set(['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'])
const CONTEXT_NAMES = ['AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']
const MAX_TEXT_BYTES = 1024 * 1024
const OPENABLE_EXTENSIONS = new Set(['.md', '.json', '.jsonl'])

const STRING_SETTINGS = [
  'defaultProvider',
  'defaultModel',
  'subagentDefaultModel',
  'auxiliaryModel',
  'defaultThinkingLevel',
  'defaultServiceTier',
  'transport',
  'steeringMode',
  'followUpMode',
  'theme',
  'providerBackupModel',
  'imageModel',
  'shellPath',
  'shellCommandPrefix',
  'treeFilterMode',
  'chatDetail',
  'markdown.codeBlockIndent',
  'markdown.mermaid',
  'sessionDir',
  'updateChannel'
]
const BOOLEAN_SETTINGS = [
  'onboardingShown',
  'onboardingCompleted',
  'compaction.enabled',
  'compaction.agentCallable',
  'autoRefine.enabled',
  'autoRefine.compact',
  'agentTraces.enabled',
  'factory.enabled',
  'telemetry.enabled',
  'telemetry.noticeShown',
  'telemetry.localMirror',
  'branchSummary.skipPrompt',
  'retry.enabled',
  'retry.failover.enabled',
  'retry.provider.waitForUsage.enabled',
  'retry.provider.waitForUsage.pauseUntilReset',
  'quietStartup',
  'enableSkillCommands',
  'bundledSkills.websearch',
  'enableBuiltinSkills',
  'terminal.showImages',
  'terminal.clearOnShrink',
  'terminal.showTerminalProgress',
  'terminal.fullscreenMouse',
  'images.autoResize',
  'images.blockImages',
  'showHardwareCursor',
  'warnings.anthropicExtraUsage',
  'requestTiming'
]
const NUMBER_SETTINGS = [
  'rlmMaxDepth',
  'compaction.reserveTokens',
  'compaction.keepRecentTokens',
  'autoRefine.turnInterval',
  'autoRefine.cooldownMs',
  'branchSummary.reserveTokens',
  'retry.maxRetries',
  'retry.baseDelayMs',
  'retry.failover.maxRetries',
  'retry.failover.baseDelayMs',
  'retry.failover.maxDelayMs',
  'retry.provider.timeoutMs',
  'retry.provider.maxRetryDelayMs',
  'retry.provider.waitForUsage.baseDelayMs',
  'retry.provider.waitForUsage.maxDelayMs',
  'retry.provider.waitForUsage.maxAttempts',
  'retry.provider.waitForUsage.maxWaitMs',
  'retry.provider.waitForUsage.maxPauseMs',
  'retry.provider.waitForUsage.maxParks',
  'thinkingBudgets.minimal',
  'thinkingBudgets.low',
  'thinkingBudgets.medium',
  'thinkingBudgets.high',
  'editorPaddingX',
  'autocompleteMaxVisible'
]
const STRING_ARRAY_SETTINGS = [
  'recentModels',
  'npmCommand',
  'mcpCatalogSources',
  'skills',
  'prompts',
  'themes',
  'enabledModels',
  'allowedModels'
]
const SETTING_CHOICES: Record<string, string[]> = {
  updateChannel: ['stable', 'nightly'],
  defaultThinkingLevel: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  steeringMode: ['all', 'one-at-a-time', 'oneAtATime'],
  followUpMode: ['all', 'one-at-a-time', 'oneAtATime'],
  transport: ['auto', 'sse', 'websocket', 'web-socket', 'websocket-cached'],
  'markdown.mermaid': ['off', 'final', 'streaming']
}

function settingAt(data: JsonObject, path: string): unknown {
  let value: unknown = data
  for (const key of path.split('.')) value = jsonObject(value)?.[key]
  return value
}

function validateSettingsData(data: JsonObject): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const check = (paths: string[], valid: (value: unknown) => boolean, message: string): void => {
    for (const key of paths) {
      const value = settingAt(data, key)
      if (value !== undefined && value !== null && !valid(value)) {
        issues.push({ severity: 'error', key, message })
      }
    }
  }
  check(STRING_SETTINGS, (value) => typeof value === 'string', 'Use a text value.')
  check(BOOLEAN_SETTINGS, (value) => typeof value === 'boolean', 'Use true or false.')
  const nonnegativeInteger = (value: unknown): boolean =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  check(NUMBER_SETTINGS, nonnegativeInteger, 'Use a non-negative whole number.')
  check(
    STRING_ARRAY_SETTINGS,
    (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
    'Use a list of text values.'
  )
  for (const [key, choices] of Object.entries(SETTING_CHOICES)) {
    check(
      [key],
      (value) => typeof value === 'string' && choices.includes(value),
      `Choose ${choices.join(', ')}.`
    )
  }
  const nonnegativeNumber = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  check(
    ['idleEvictionMinutes', 'sessionArchiveMaxAgeDays', 'sessionArchiveMaxSessions'],
    (value) => nonnegativeNumber(value) || value === 'off' || value === 'none',
    'Use a non-negative number, off, or none.'
  )
  check(
    [
      'autonomous.maxContinuations',
      'autonomous.maxTurns',
      'autonomous.maxTokens',
      'autonomous.timeoutMs'
    ],
    (value) => nonnegativeNumber(value) || value === 'unlimited',
    'Use a non-negative number or unlimited.'
  )
  const objectSettings = new Set(
    [...STRING_SETTINGS, ...BOOLEAN_SETTINGS, ...NUMBER_SETTINGS]
      .filter((key) => key.includes('.'))
      .map((key) => key.split('.')[0]!)
  )
  check(
    [...objectSettings, 'mcpServers', 'autonomous'],
    (value) => !!jsonObject(value),
    'Use a JSON object.'
  )
  check(['packages'], Array.isArray, 'Use a list of package sources.')
  return issues
}

export async function primeSettingsSnapshot(cwd: string | null): Promise<SettingsSnapshot> {
  const global = safePrimeFileState(await readPrimeJson(primeSettingsPath('global', cwd)))
  const project = cwd
    ? safePrimeFileState(await readPrimeJson(primeSettingsPath('project', cwd)))
    : null
  const sessionVariable = process.env.PRIME_AGENT_SESSION_DIR
    ? 'PRIME_AGENT_SESSION_DIR'
    : process.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR
      ? 'PRIME_AGENT_CODING_AGENT_SESSION_DIR'
      : undefined
  return {
    agentDir: getPrimeAgentDir(),
    global,
    project:
      project && cwd
        ? { ...project, cwd, trust: { saved: null, fallback: 'always', effective: true } }
        : null,
    isolated:
      !!process.env.PRIME_AGENT_CODING_AGENT_DIR ||
      ['1', 'true'].includes(process.env.VENGEANCE_MOCK ?? ''),
    envOverrides: sessionVariable
      ? { sessionDir: { variable: sessionVariable, value: process.env[sessionVariable]! } }
      : {}
  }
}

export function validatePrimeSettings(text: string): ValidationIssue[] {
  try {
    return validateSettingsData(parsePrimeJson(text))
  } catch {
    return [{ severity: 'error', key: '', message: 'Enter a valid JSON object.' }]
  }
}

export async function setPrimeSetting(
  args: SetSettingArgs,
  overridePath?: string | null
): Promise<SettingsSnapshot> {
  if (!Array.isArray(args.path) || !args.path.length) throw new Error('Choose a setting to change.')
  const inherited =
    args.scope === 'project' ? await readPrimeJson(primeSettingsPath('global', args.cwd)) : null
  if (args.path[0] === 'factory') {
    const current = await readPrimeJson(primeSettingsPath(args.scope, args.cwd))
    await assertPrimeFactoryChange(
      args.scope,
      args.cwd,
      current.data,
      setPrimeValue(current.data, args.path, args.value),
      overridePath
    )
  }
  await updatePrimeJson(primeSettingsPath(args.scope, args.cwd), (current) => {
    const updated = setPrimeValue(current, args.path, args.value)
    const issues = validateSettingsData(updated)
    if (issues.length)
      throw new Error(issues.map((issue) => `${issue.key}: ${issue.message}`).join('\n'))
    return restorePrimeSecrets(updated, mergePrimeSettings(inherited?.data ?? {}, current))
  })
  return primeSettingsSnapshot(args.cwd)
}

export async function writePrimeSettings(
  args: WriteRawSettingsArgs,
  overridePath?: string | null
): Promise<SettingsSnapshot> {
  const data = parsePrimeJson(args.text)
  const issues = validateSettingsData(data)
  if (issues.length)
    throw new Error(issues.map((issue) => `${issue.key}: ${issue.message}`).join('\n'))
  const current = await readPrimeJson(primeSettingsPath(args.scope, args.cwd))
  await assertPrimeFactoryChange(args.scope, args.cwd, current.data, data, overridePath)
  const inherited =
    args.scope === 'project' ? await readPrimeJson(primeSettingsPath('global', args.cwd)) : null
  await updatePrimeJson(
    primeSettingsPath(args.scope, args.cwd),
    (current) => restorePrimeSecrets(data, mergePrimeSettings(inherited?.data ?? {}, current)),
    true
  )
  return primeSettingsSnapshot(args.cwd)
}

async function firstContextFile(directory: string): Promise<string | undefined> {
  for (const name of CONTEXT_NAMES) {
    const path = join(directory, name)
    try {
      if ((await stat(path)).isFile()) return path
    } catch {
      // Missing candidates are normal while walking parent directories.
    }
  }
  return undefined
}

export async function primeContextOverview(cwd: string | null): Promise<ContextOverview> {
  const directories = [getPrimeAgentDir()]
  if (cwd) {
    const parents: string[] = []
    let directory = resolve(cwd)
    for (;;) {
      parents.unshift(directory)
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    directories.push(...parents)
  }
  const contextFiles: ContextOverview['contextFiles'] = []
  for (const directory of [...new Set(directories)]) {
    const path = await firstContextFile(directory)
    if (path) contextFiles.push({ path, bytes: (await stat(path)).size })
  }
  const systemFiles: ContextOverview['systemFiles'] = []
  for (const kind of ['SYSTEM.md', 'APPEND_SYSTEM.md'] as const) {
    for (const scope of (cwd ? ['project', 'global'] : ['global']) as Array<'global' | 'project'>) {
      const path = join(scope === 'project' ? primeProjectDir(cwd!) : getPrimeAgentDir(), kind)
      try {
        if ((await stat(path)).isFile()) {
          systemFiles.push({ path, kind, scope })
          break
        }
      } catch {
        // Each kind falls back from the project's file to the global one.
      }
    }
  }
  return { contextFiles, systemFiles, defaultSessionDir: await primeSessionRoot(cwd) }
}

async function instructionPath(cwd: string | null, reference: InstructionFileRef): Promise<string> {
  if (!INSTRUCTION_KINDS.has(reference.kind)) throw new Error('Unknown instruction file.')
  if (reference.scope === 'project' && !cwd) throw new Error('Choose a workspace first.')
  const base =
    reference.scope === 'global'
      ? getPrimeAgentDir()
      : reference.kind === 'AGENTS.md'
        ? cwd!
        : primeProjectDir(cwd!)
  if (reference.kind === 'AGENTS.md')
    return (await firstContextFile(base)) ?? join(base, reference.kind)
  return join(base, reference.kind)
}

export async function readPrimeInstruction(
  cwd: string | null,
  reference: InstructionFileRef
): Promise<InstructionFileState> {
  const path = await instructionPath(cwd, reference)
  try {
    if ((await stat(path)).size > MAX_TEXT_BYTES)
      throw new Error('This instruction file is too large to edit.')
    return { ...reference, path, exists: true, text: await readFile(path, 'utf8') }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ...reference, path, exists: false, text: '' }
    throw error
  }
}

export async function writePrimeInstruction(
  cwd: string | null,
  reference: InstructionFileRef,
  text: string | null
): Promise<InstructionFileState> {
  const path = await instructionPath(cwd, reference)
  if (text === null) {
    try {
      await stat(path)
      await shell.trashItem(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  } else {
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
      throw new Error('This instruction file is too large.')
    await writePrimeText(path, text)
  }
  return readPrimeInstruction(cwd, reference)
}

export async function primeKeybindings(): Promise<KeybindingsState> {
  const file = await readPrimeJson(join(getPrimeAgentDir(), 'keybindings.json'))
  const bindings = Object.fromEntries(
    Object.entries(file.data).map(([key, value]) => [
      key,
      typeof value === 'string' ? [value] : jsonStrings(value)
    ])
  )
  return {
    path: file.path,
    exists: file.exists,
    error: file.error,
    actions: primeKeybindingActions(),
    bindings
  }
}

export async function writePrimeKeybindings(
  bindings: Record<string, string[]>
): Promise<KeybindingsState> {
  for (const values of Object.values(bindings)) {
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new Error('Keybindings must contain arrays of non-empty key combinations.')
    }
  }
  await updatePrimeJson(join(getPrimeAgentDir(), 'keybindings.json'), () => bindings as JsonObject)
  return primeKeybindings()
}

export async function primeLogTail(maxBytes: number): Promise<TextTail> {
  const path = join(getPrimeAgentDir(), 'mcp.log')
  try {
    const file = await open(path, 'r')
    try {
      const metadata = await file.stat()
      const bytes = Math.min(metadata.size, Math.max(0, Math.min(MAX_TEXT_BYTES, maxBytes)))
      const buffer = Buffer.alloc(bytes)
      await file.read(buffer, 0, bytes, metadata.size - bytes)
      const text = buffer.toString('utf8')
      return {
        path,
        exists: true,
        text: bytes < metadata.size ? text.slice(text.indexOf('\n') + 1) : text
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { path, exists: false, text: '' }
    throw error
  }
}

export async function openPrimePath(path: string, cwd?: string | null): Promise<void> {
  const target = await realpath(path)
  const roots = [getPrimeAgentDir(), ...(cwd ? [cwd] : [])]
  const allowed = roots.some((root) => {
    const difference = relative(resolve(root), target)
    return (
      !difference ||
      (!difference.startsWith(`..${sep}`) && difference !== '..' && !difference.includes(':'))
    )
  })
  if (
    !allowed ||
    (!OPENABLE_EXTENSIONS.has(extname(target).toLowerCase()) && !(await stat(target)).isDirectory())
  ) {
    shell.showItemInFolder(target)
    return
  }
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
}
