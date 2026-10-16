/**
 * Composer feature (input, attachments, @mentions, /commands, queue) + command palette prefs.
 * Handlers live in src/main/ipc/composer.ts; prefs are stored under AppPersistedState.features.composer.
 */

/** A dropped or picked file, resolved against the agent's workspace. */
export interface ComposerPathInfo {
  /** Absolute path as given. */
  path: string
  name: string
  /** Text inserted after `@`: workspace-relative with forward slashes when inside the workspace, else absolute. */
  mention: string
  isDirectory: boolean
  /** Raster image the composer can attach as ImageContent. */
  isImage: boolean
  size: number
}

/** Raw image bytes for the renderer to resize/compress before sending. */
export interface ComposerImageFile {
  name: string
  mimeType: string
  /** base64 */
  data: string
  size: number
}

export interface ComposerInvokeMap {
  'composer:describe-paths': [cwd: string, paths: string[], result: ComposerPathInfo[]]
  /** Read an image file (bounded to 32 MiB). */
  'composer:read-image': [path: string, result: ComposerImageFile]
  /**
   * `argument-hint` frontmatter of markdown-backed commands (prompt templates, skills), keyed by the given
   * `sourceInfo.path`; relative paths resolve against `cwd`. Paths without a hint are omitted.
   */
  'composer:command-hints': [cwd: string, paths: string[], result: Record<string, string>]
}

export interface ComposerEventMap {}

export interface ComposerPrefs {
  /** Submitted prompts, newest last (bounded), for Up/Down history in the composer. */
  history?: string[]
  /** Recently used command palette item ids, newest first (bounded). */
  paletteRecents?: string[]
  /** The todo list docked above the composer shows only its heading and current task. */
  checklistCollapsed?: boolean
}
