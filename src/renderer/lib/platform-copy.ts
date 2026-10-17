import { platform } from './ipc'

/** UI wording that names the operating system or one of its parts. */

/** The system file browser, as "Show in …" names it. */
const FILE_BROWSER = { win32: 'Explorer', darwin: 'Finder', linux: 'the file manager' }[platform.os]

/** Showing a file in its folder in the system file browser. */
export const REVEAL_LABEL = `Show in ${FILE_BROWSER}`

/** REVEAL_LABEL for a named item, e.g. "Show extensions in Explorer". */
export function revealLabelFor(name: string): string {
  return `Show ${name} in ${FILE_BROWSER}`
}

/** Where deleted files go (`shell.trashItem`): the Recycle Bin on Windows, the Trash elsewhere. */
export const TRASH_NAME = platform.os === 'win32' ? 'Recycle Bin' : 'Trash'

/** The system the "System" appearance choices follow; Linux desktops vary, so "your desktop". */
export const SYSTEM_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'your desktop' }[platform.os]

/** One of the system's own settings, e.g. "the Windows animation setting". */
export function systemSetting(name: string): string {
  return platform.os === 'linux'
    ? `your desktop’s ${name} setting`
    : `the ${SYSTEM_NAME} ${name} setting`
}
