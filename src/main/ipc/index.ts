import type { IpcContext } from './context'
import { registerAppIpc } from './app'
import { registerComposerIpc } from './composer'
import { registerEngineIpc } from './engine'
import { registerLaunchIpc } from './launch'
import { registerSessionsIpc } from './sessions'
import { registerSettingsIpc } from './settings'
import { registerSystemIpc } from './system'
import { registerUpdatesIpc } from './updates'

/** Register every IPC handler. Each feature owns its own module; this list is the only shared line. */
export function registerIpc(context: IpcContext): void {
  registerEngineIpc(context.manager)
  registerSystemIpc(context.manager)
  registerAppIpc()
  registerComposerIpc(context)
  registerSettingsIpc(context)
  registerSessionsIpc(context)
  registerLaunchIpc(context)
  registerUpdatesIpc(context)
}
