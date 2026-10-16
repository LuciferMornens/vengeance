import type { JsonObject, ProjectTrustInfo, SetSettingArgs, SettingEnvOverride, SettingsScope, SettingsSnapshot, WriteRawSettingsArgs } from '@shared/api/settings'
import { trustPreflight } from '../launch/trust'
import { agentDir, globalSettingsPath, isIsolatedAgentDir, projectSettingsPath, SESSION_DIR_ENV } from './agent-dir'
import { readJsonFile, replaceJsonFile, serializeJson, setAtPath, updateJsonFile } from './json-file'
import { parseSettingsText, validateSettings } from './validate'

/** settings.json (global + project) read/write through files with pi's lock; never touches secrets. */

type DefaultTrust = ProjectTrustInfo['fallback']

function asTrust(value: unknown): DefaultTrust {
  return value === 'always' || value === 'never' ? value : 'ask'
}

/** Same lookup as the launch preflight (N9): the decision saved for the workspace path or a parent. */
async function trustInfo(override: string | null, cwd: string, global: JsonObject): Promise<ProjectTrustInfo> {
  const fallback = asTrust(global.defaultProjectTrust)
  const saved = await trustPreflight(override, cwd).then(
    (preflight) => preflight.saved,
    () => null
  )
  // RPC mode cannot prompt: "ask" behaves like "never" (security.md).
  return { saved, fallback, effective: saved ?? fallback === 'always' }
}

export async function settingsSnapshot(override: string | null, cwd: string | null): Promise<SettingsSnapshot> {
  const globalPath = globalSettingsPath()
  const global = readJsonFile(globalPath)
  let project: SettingsSnapshot['project'] = null
  if (cwd) {
    const path = projectSettingsPath(cwd)
    project = { ...readJsonFile(path), path, cwd, trust: await trustInfo(override, cwd, global.data) }
  }
  return { agentDir: agentDir(), global: { ...global, path: globalPath }, project, isolated: isIsolatedAgentDir(), envOverrides: envOverrides() }
}

/** Engines inherit Vengeance's environment, so these variables beat settings.json in every session. */
function envOverrides(): Record<string, SettingEnvOverride> {
  const sessionDir = process.env[SESSION_DIR_ENV]
  return sessionDir ? { sessionDir: { variable: SESSION_DIR_ENV, value: sessionDir } } : {}
}

function pathFor(scope: SettingsScope, cwd: string | null): string {
  if (scope === 'global') return globalSettingsPath()
  if (!cwd) throw new Error('Open a project to edit project settings.')
  return projectSettingsPath(cwd)
}

export async function setSetting(override: string | null, args: SetSettingArgs): Promise<SettingsSnapshot> {
  if (args.path.length === 0) throw new Error('Empty setting path')
  await updateJsonFile(pathFor(args.scope, args.cwd), override, (current) => setAtPath(current, args.path, args.value))
  return settingsSnapshot(override, args.cwd)
}

/** Apply several changes to one file in a single locked write. */
export async function updateSettingsObject(override: string | null, scope: SettingsScope, cwd: string | null, mutate: (current: JsonObject) => JsonObject): Promise<void> {
  await updateJsonFile(pathFor(scope, cwd), override, mutate)
}

export function readScopeSettings(scope: SettingsScope, cwd: string | null): JsonObject {
  return readJsonFile(pathFor(scope, cwd)).data
}

export async function writeRawSettings(override: string | null, args: WriteRawSettingsArgs): Promise<SettingsSnapshot> {
  const parsed = parseSettingsText(args.text)
  if (parsed.issue) throw new Error(parsed.issue.message)
  const errors = validateSettings(parsed.data!, args.scope).filter((i) => i.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('\n'))
  const text = args.text.trim() ? serializeJson(parsed.data!) : '{}\n'
  // The text was validated above, so it may replace a file that no longer parses (the fix for a broken file).
  await replaceJsonFile(pathFor(args.scope, args.cwd), override, text)
  return settingsSnapshot(override, args.cwd)
}

export function validateRawSettings(text: string, scope: SettingsScope) {
  const parsed = parseSettingsText(text)
  if (parsed.issue) return [parsed.issue]
  return validateSettings(parsed.data!, scope)
}
