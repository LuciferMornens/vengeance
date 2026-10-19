import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'

/** The macOS Helper's LSUIElement keeps Electron-as-Node children out of the Dock. */
export function electronNodeExecutable(): string {
  if (process.platform !== 'darwin' || !process.versions.electron) return process.execPath

  // Electron 44 supplies this internal property outside its public TypeScript declarations.
  const { helperExecPath } = process as NodeJS.Process & { readonly helperExecPath?: unknown }
  if (
    typeof helperExecPath !== 'string' ||
    helperExecPath.trim().length === 0 ||
    !isAbsolute(helperExecPath)
  ) {
    throw new Error('The macOS background runtime path is missing or invalid. Reinstall Vengeance.')
  }

  try {
    accessSync(helperExecPath, constants.X_OK)
  } catch (cause) {
    throw new Error(
      `The macOS background runtime is unavailable at ${helperExecPath}. Reinstall Vengeance.`,
      { cause }
    )
  }
  return helperExecPath
}
