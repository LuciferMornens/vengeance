import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { PlatformInfo } from '@shared/api/app'
import {
  CHANNEL_PATTERN,
  type InvokeChannel,
  type InvokeEnvelope,
  type VengeanceBridge
} from '@shared/ipc'

function readPlatform(): PlatformInfo {
  const arg = process.argv.find((a) => a.startsWith('--vengeance-platform='))
  if (!arg) throw new Error('Vengeance preload: missing platform info')
  try {
    return JSON.parse(decodeURIComponent(arg.slice('--vengeance-platform='.length))) as PlatformInfo
  } catch (cause) {
    throw new Error('Vengeance preload: malformed platform info', { cause })
  }
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel)) throw new Error(`Invalid IPC channel: ${channel}`)
}

const bridge: VengeanceBridge = {
  async invoke(channel: InvokeChannel, ...args: unknown[]) {
    assertChannel(channel)
    const envelope = (await ipcRenderer.invoke(channel, ...args)) as InvokeEnvelope<never>
    if (!envelope.ok) {
      const error = new Error(envelope.error.message) as Error & { code?: string }
      error.code = envelope.error.code
      throw error
    }
    return envelope.value
  },
  on(channel, listener) {
    assertChannel(channel)
    const wrapped = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload as Parameters<typeof listener>[0])
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  platform: readPlatform()
}

contextBridge.exposeInMainWorld('vengeance', bridge)
