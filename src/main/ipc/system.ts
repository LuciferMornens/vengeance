import { BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appState } from '../app-state'
import type { EngineManager } from '../engine/manager'
import { agentDir, SESSION_DIR_ENV } from '../features/settings/agent-dir'
import { physicalPath } from '../paths'
import { applyWindowTheme } from '../window'
import { listFiles, readFileBounded, type ReadAccess } from './files'
import { handle } from './handle'

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No window for this request')
  return window
}

const EXTERNAL_PROTOCOLS = /^(https?|mailto):/i

/**
 * sys:read-file may read inside open workspaces (known workspaces + running agents' cwds) and session
 * folders, never the engine's credential files.
 */
function readAccess(manager: EngineManager): ReadAccess {
  const config = agentDir()
  const agents = manager.list()
  const roots = [
    ...appState.getPrefs().workspaces.map((w) => w.path),
    ...agents.map((a) => a.cwd),
    join(config, 'sessions'),
    ...agents.flatMap((a) => [a.sessionFile ? dirname(a.sessionFile) : null, a.args.sessionDir ?? null]),
    process.env[SESSION_DIR_ENV] ?? null
  ]
  return {
    allowedRoots: roots.filter((root): root is string => !!root),
    deniedFiles: [join(config, 'auth.json'), join(config, 'models.json')]
  }
}

export function registerSystemIpc(manager: EngineManager): void {
  handle('sys:pick-folder', async (options, event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: options?.title ?? 'Choose a project folder',
      defaultPath: options?.defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    const folder = result.canceled ? undefined : result.filePaths[0]
    // A linked folder opens as its target, which is the workspace pi records for it.
    return folder ? physicalPath(folder) : null
  })

  handle('sys:dropped-folder', async (path) => {
    try {
      return (await stat(path)).isDirectory() ? physicalPath(path) : null
    } catch {
      return null
    }
  })

  handle('sys:pick-files', async (options, event) => {
    const result = await dialog.showOpenDialog(senderWindow(event), {
      title: options?.title ?? 'Choose files',
      defaultPath: options?.defaultPath,
      filters: options?.filters,
      properties: options?.multiple === false ? ['openFile'] : ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  handle('sys:open-external', async (url) => {
    if (!EXTERNAL_PROTOCOLS.test(url)) throw new Error(`Refusing to open ${url}`)
    await shell.openExternal(url)
  })

  handle('sys:reveal', (path) => shell.showItemInFolder(path))
  handle('sys:read-file', (path, options) => readFileBounded(path, options, readAccess(manager)))
  handle('sys:list-files', (cwd, query, options) => listFiles(cwd, query, options?.limit))

  handle('win:minimize', (event) => senderWindow(event).minimize())
  handle('win:toggle-maximize', (event) => {
    const window = senderWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  handle('win:close', (event) => senderWindow(event).close())
  handle('win:is-maximized', (event) => senderWindow(event).isMaximized())
  handle('win:set-theme', (theme, event) => applyWindowTheme(senderWindow(event), theme))
}
