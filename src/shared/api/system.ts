import type { ThemePref } from './app'

export interface PickFolderOptions {
  title?: string
  defaultPath?: string
}

export interface PickFilesOptions {
  title?: string
  defaultPath?: string
  multiple?: boolean
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface ReadFileOptions {
  /** Default 512 KiB, hard cap 4 MiB. */
  maxBytes?: number
  /** Resolve relative paths against this folder. */
  cwd?: string
}

export interface ReadFileResult {
  path: string
  size: number
  /** UTF-8 text (empty when `binary`). */
  content: string
  truncated: boolean
  binary: boolean
}

export interface FileMatch {
  /** Path relative to the workspace, forward slashes. */
  path: string
  score: number
}

export interface ListFilesOptions {
  /** Default 50. */
  limit?: number
}

export type WindowTheme = 'dark' | 'light'

export interface SystemInvokeMap {
  'sys:pick-folder': [options: PickFolderOptions | undefined, result: string | null]
  'sys:pick-files': [options: PickFilesOptions | undefined, result: string[]]
  'sys:open-external': [url: string, result: void]
  'sys:reveal': [path: string, result: void]
  'sys:read-file': [path: string, options: ReadFileOptions | undefined, result: ReadFileResult]
  'sys:list-files': [cwd: string, query: string, options: ListFilesOptions | undefined, result: FileMatch[]]
  'win:minimize': [result: void]
  'win:toggle-maximize': [result: void]
  'win:close': [result: void]
  'win:is-maximized': [result: boolean]
  /** Sync native caption buttons + window background with the renderer theme. */
  'win:set-theme': [theme: WindowTheme, result: void]
  /** The theme preference behind it: "system" keeps the native theme following Windows (sent before win:set-theme). */
  'win:set-theme-preference': [preference: ThemePref, result: void]
}

export interface SystemEventMap {
  'win:maximized-changed': { maximized: boolean }
  'win:focus-changed': { focused: boolean }
}
