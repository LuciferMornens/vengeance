import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { childBaseEnv, shellEnvironmentReady } from './shell-env'

const execFileAsync = promisify(execFile)
const MACOS_GIT_STUB = '/usr/bin/git'

let usable = false

function firstOnPath(name: string, path: string): string | undefined {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined
}

function developerToolsInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { timeout: 5_000 }, (error) => resolve(!error))
  })
}

/**
 * Whether the app may run `git` itself. macOS ships `/usr/bin/git` as a stub that opens the Command Line Tools
 * installer when they are missing, so, as in VS Code, that git only counts once `xcode-select -p` finds the tools.
 */
async function gitUsable(): Promise<boolean> {
  if (process.platform !== 'darwin' || usable) return true
  await shellEnvironmentReady()
  const git = firstOnPath('git', childBaseEnv().PATH ?? '')
  usable = git !== undefined && (git !== MACOS_GIT_STUB || (await developerToolsInstalled()))
  return usable
}

/** Run `git` for the app's own queries (workspace file lists, package revisions) and return its stdout. */
export async function runGit(
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer?: number }
): Promise<string> {
  if (!(await gitUsable())) throw new Error('git is not installed')
  const { stdout } = await execFileAsync('git', args, {
    ...options,
    windowsHide: true,
    env: childBaseEnv()
  })
  return stdout
}
