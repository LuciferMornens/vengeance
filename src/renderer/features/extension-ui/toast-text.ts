import { friendlyExtensionName } from '@shared/display-names'
import type { ExtensionErrorEvent } from '@shared/engine-types'

/** A notify message as toast text: the first line is the title, the rest (line breaks kept) the description. */
export function splitNotifyMessage(message: string): { title: string; description?: string } {
  const lines = message.replace(/\r\n?/g, '\n').split('\n')
  const first = lines.findIndex((line) => line.trim())
  if (first < 0) return { title: message.trim() }
  const rest = lines
    .slice(first + 1)
    .join('\n')
    .replace(/^\s*\n|\s+$/g, '')
  return { title: lines[first]!.trim(), description: rest || undefined }
}

/** Build and source folders that say nothing about which extension a file belongs to. */
const GENERIC_FOLDERS = new Set(['dist', 'src', 'lib', 'build', 'out', 'extension', 'extensions'])

/** "…/pi-lens-lsp/dist/index.js" → "Lens LSP"; "…/extensions/qa-fixture.ts" → "Qa fixture". */
function extensionLabel(extensionPath: string): string {
  const parts = extensionPath.split(/[\\/]/).filter(Boolean)
  const file = (parts.pop() ?? extensionPath).replace(/\.[cm]?[jt]sx?$/i, '')
  if (file.toLowerCase() !== 'index') return friendlyExtensionName(file)
  const folder = [...parts].reverse().find((part) => !GENERIC_FOLDERS.has(part.toLowerCase()))
  return folder ? friendlyExtensionName(folder) : 'An extension'
}

/**
 * Toast text for an extension failure. The Engine reports a throwing command as `command:<name>`; other
 * failures name the extension file and the event its handler ran for. Only the first line of the error shows.
 */
export function extensionErrorText(error: ExtensionErrorEvent): { title: string; description: string } {
  const description = error.error.trim().split('\n')[0]!.trim()
  const command = /^command:(.+)$/.exec(error.extensionPath)?.[1]
  if (command) return { title: `/${command} failed`, description }
  return { title: `${extensionLabel(error.extensionPath)} ran into an error`, description }
}
