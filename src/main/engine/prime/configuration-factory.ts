import { resolve } from 'node:path'
import type { JsonObject, SettingsScope } from '@shared/api/settings'
import { connectPrimeResident, listPrimeBackground } from './daemon'
import { jsonObject, primeSettingsPath, readPrimeJson } from './configuration-store'

const FACTORY_STATUS_TIMEOUT_MS = 2_000

function factoryEnabled(settings: JsonObject, fallback = false): boolean {
  const enabled = jsonObject(settings.factory)?.enabled
  return typeof enabled === 'boolean' ? enabled : fallback
}

function sameWorkspace(left: string, right: string): boolean {
  const leftPath = resolve(left)
  const rightPath = resolve(right)
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath
}

export async function assertPrimeFactoryChange(
  scope: SettingsScope,
  cwd: string | null,
  current: JsonObject,
  updated: JsonObject,
  overridePath?: string | null
): Promise<void> {
  const previous = jsonObject(current.factory)?.enabled
  const next = jsonObject(updated.factory)?.enabled
  if (previous === next || next === true) return
  const options = { executablePath: overridePath }
  const global = scope === 'project' ? await readPrimeJson(primeSettingsPath('global', cwd)) : null
  const residents = await listPrimeBackground(options)
  for (const resident of residents) {
    if (scope === 'project' && (!cwd || !sameWorkspace(cwd, resident.cwd))) continue
    const project =
      scope === 'global' && resident.cwd
        ? await readPrimeJson(primeSettingsPath('project', resident.cwd))
        : null
    if (global?.error || project?.error) {
      throw new Error('Factory status could not be checked because workspace settings are invalid.')
    }
    const before = project
      ? factoryEnabled(project.data, factoryEnabled(current))
      : factoryEnabled(current, global ? factoryEnabled(global.data) : false)
    const after = project
      ? factoryEnabled(project.data, factoryEnabled(updated))
      : factoryEnabled(updated, global ? factoryEnabled(global.data) : false)
    if (!before || after) continue
    const connection = await connectPrimeResident({ nativeAgentId: resident.id }, options)
    if (!connection) throw new Error('Factory status changed. Refresh the session and try again.')
    let graph: Record<string, unknown>
    try {
      graph = await connection.client.request(
        'factory_activity',
        { activeSessionId: connection.nativeAgentId, action: 'graph' },
        FACTORY_STATUS_TIMEOUT_MS
      )
    } catch (error) {
      if ((error as Error).message === 'Kernel is not running') continue
      throw new Error(
        'Could not check factory activity. Refresh its activity view before disabling it.'
      )
    } finally {
      connection.client.close()
    }
    if (!Array.isArray(graph.runs)) {
      throw new Error(
        'The engine did not report factory activity. Refresh its activity view before disabling it.'
      )
    }
    const live = graph.runs.some((raw) => {
      const run = jsonObject(raw)
      const running = jsonObject(run?.usage)?.running
      return (
        ['running', 'stopping', 'paused'].includes(String(run?.state)) ||
        (typeof running === 'number' && running > 0)
      )
    })
    if (live) throw new Error('Stop active factory runs before disabling factory mode.')
  }
}
