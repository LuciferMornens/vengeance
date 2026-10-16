import type { EngineId } from '@shared/api/engine'
import type {
  EngineSettingsRequest,
  EngineSettingsResult,
  SettingsArguments,
  SettingsChannel
} from '@shared/api/settings'
import type { InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc'
import { invoke as invokeIpc } from '../../lib/ipc'
import { useApp } from '../../store/app'
import { useSettings } from './store'

export { on } from '../../lib/ipc'

export async function settingsInvoke<Channel extends SettingsChannel>(
  engine: EngineId,
  channel: Channel,
  ...args: SettingsArguments<Channel>
): Promise<EngineSettingsResult<Channel>> {
  return settingsInvokeForFolder(engine, useApp.getState().prefs.activeWorkspace, channel, ...args)
}

export async function settingsInvokeForFolder<Channel extends SettingsChannel>(
  engine: EngineId,
  cwd: string | null,
  channel: Channel,
  ...args: SettingsArguments<Channel>
): Promise<EngineSettingsResult<Channel>> {
  // IPC serializes the discriminated request; the channel preserves its reply type here.
  const request = { engine, cwd, channel, args } as unknown as EngineSettingsRequest
  return (await invokeIpc('engine:settings', request)) as EngineSettingsResult<Channel>
}

export async function invoke<Channel extends InvokeChannel>(
  channel: Channel,
  ...args: InvokeArgs<Channel>
): Promise<InvokeResult<Channel>> {
  if (!channel.startsWith('settings:')) return invokeIpc(channel, ...args)
  // Settings channels share one engine-scoped transport without changing their typed callers.
  const request = {
    engine: useSettings.getState().engine,
    cwd: useApp.getState().prefs.activeWorkspace,
    channel,
    args
  } as unknown as EngineSettingsRequest
  return (await invokeIpc('engine:settings', request)) as InvokeResult<Channel>
}
