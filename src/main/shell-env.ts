import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { basename, isAbsolute } from 'node:path'
import { electronNodeExecutable } from './electron-node'
import { env } from './env'

/**
 * The environment child processes start from. Apps opened from the Dock, Finder or a desktop launcher get the
 * session's minimal PATH, without what the user's shell profile adds (Homebrew, mise/nvm/asdf, ~/.local/bin, API
 * keys), so on macOS and Linux the login shell's environment is read once at startup, the way VS Code does, and
 * merged into every child's environment. Windows children inherit the app's environment unchanged.
 */

const SHELL_TIMEOUT_MS = 10_000
const RESOLVING_VARIABLE = 'VENGEANCE_RESOLVING_ENVIRONMENT'
/**
 * Never taken from the shell: engine and app selection variables, which main reads from its own environment and
 * children must agree with, Electron's switches, and state of the probe shell itself. VS Code also keeps the
 * launch XDG_RUNTIME_DIR.
 */
const LAUNCH_ONLY = /^(PI_|PRIME_|VENGEANCE_|ELECTRON_)/
const SHELL_SESSION = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'XDG_RUNTIME_DIR'])

/** Variables the login shell sets differently from the launch environment. */
let shellChanges: Record<string, string> = {}
let ready: Promise<void> = Promise.resolve()

function loginShell(): string {
  let account: string | undefined
  try {
    account = userInfo().shell ?? undefined
  } catch {
    // No passwd entry (some containers).
  }
  for (const shell of [process.env.SHELL, account]) {
    if (shell && isAbsolute(shell) && !/\/(false|nologin)$/.test(shell)) return shell
  }
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Arguments that make `shell` start as a login shell and print the environment between `marker`s. */
function probeArguments(shell: string, marker: string): string[] {
  const name = basename(shell)
  const print = `"${marker}" + JSON.stringify(process.env) + "${marker}"`
  if (/^(pwsh|powershell)(-preview)?$/.test(name)) {
    // PowerShell drops double quotes from native arguments, so the script quotes with single ones ('' escaped).
    const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const script = `'${marker}' + JSON.stringify(process.env) + '${marker}'`
    return ['-Login', '-Command', `& ${literal(electronNodeExecutable())} -p ${literal(script)}`]
  }
  if (name === 'nu') return ['-i', '-l', '-c', `^'${electronNodeExecutable()}' -p '${print}'`]
  if (name === 'xonsh') {
    return [
      '-i',
      '-l',
      '-c',
      `import os, json; print("${marker}" + json.dumps(dict(os.environ)) + "${marker}")`
    ]
  }
  const command = `${posixQuote(electronNodeExecutable())} -p '${print}'`
  // csh and tcsh accept no other option together with -c.
  return name === 'csh' || name === 'tcsh' ? ['-ic', command] : ['-i', '-l', '-c', command]
}

function readShellEnvironment(shell: string): Promise<Record<string, unknown>> {
  const marker = randomBytes(8).toString('hex')
  return new Promise((resolve, reject) => {
    // Its own process group, so a timed-out probe takes everything its profile started with it. The shell starts
    // from what children get, never from an AppImage's library paths.
    const child = spawn(shell, probeArguments(shell, marker), {
      cwd: homedir(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...childBaseEnv(), ELECTRON_RUN_AS_NODE: '1', [RESOLVING_VARIABLE]: '1' }
    })
    const output: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The probe ended meanwhile.
      }
      reject(new Error(`no answer within ${SHELL_TIMEOUT_MS / 1000} s`))
    }, SHELL_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      stderr = (stderr + text).slice(-2_000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(output).toString('utf8')
      const match = new RegExp(`${marker}([\\s\\S]*?)${marker}`).exec(text)
      if (!match) {
        reject(new Error(`exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
        return
      }
      try {
        resolve(JSON.parse(match[1]!.trim()) as Record<string, unknown>)
      } catch (error) {
        reject(error as Error)
      }
    })
  })
}

async function resolveShellChanges(): Promise<void> {
  const launch = { ...process.env }
  const shell = loginShell()
  try {
    const resolved = await readShellEnvironment(shell)
    const changes: Record<string, string> = {}
    for (const [name, value] of Object.entries(resolved)) {
      if (typeof value !== 'string' || LAUNCH_ONLY.test(name) || SHELL_SESSION.has(name)) continue
      if (launch[name] !== value) changes[name] = value
    }
    shellChanges = changes
  } catch (error) {
    console.warn(
      `[vengeance] could not read the login shell environment of ${shell}: ${(error as Error).message}`
    )
  }
}

/**
 * Start reading the login shell's environment (call once, at startup). Windows, mock and test runs and
 * `VENGEANCE_SKIP_SHELL_ENV=1` keep the launch environment.
 */
export function resolveShellEnvironment(): void {
  if (process.platform === 'win32' || env.mock || env.test || env.skipShellEnv) return
  ready = resolveShellChanges()
}

/** Settles once the login shell environment is known (or could not be read); engine spawns wait for it. */
export function shellEnvironmentReady(): Promise<void> {
  return ready
}

/**
 * An AppImage's runtime points PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS, GSETTINGS_SCHEMA_DIR and friends into its
 * mount, which disappears when the app quits (resident Engine 2 daemons outlive it) and must never reach the user's
 * tools. Entries inside the mount are dropped; a variable left empty is removed.
 */
function withoutAppImage(environment: NodeJS.ProcessEnv): void {
  const mount = environment.APPDIR?.replace(/\/+$/, '')
  if (!environment.APPIMAGE || !mount) return
  for (const name of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete environment[name]
  const inMount = (entry: string): boolean => entry === mount || entry.startsWith(`${mount}/`)
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || !value.includes(mount)) continue
    const entries = value.split(':')
    const kept = entries.filter((entry) => !inMount(entry))
    if (kept.length === entries.length) continue
    if (kept.some(Boolean)) environment[name] = kept.join(':')
    else delete environment[name]
  }
}

/**
 * The environment every child process the app starts is built on: the app's own environment plus the login
 * shell's on macOS and Linux, without Electron's and the AppImage runtime's changes. Electron replaces
 * XDG_CURRENT_DESKTOP on Linux and keeps the user's value in ORIGINAL_XDG_CURRENT_DESKTOP.
 */
export function childBaseEnv(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...shellChanges }
  if (process.platform === 'win32') return environment
  delete environment.ELECTRON_RUN_AS_NODE
  if (process.platform === 'linux') {
    const desktop = environment.ORIGINAL_XDG_CURRENT_DESKTOP
    delete environment.ORIGINAL_XDG_CURRENT_DESKTOP
    if (desktop) environment.XDG_CURRENT_DESKTOP = desktop
    withoutAppImage(environment)
  }
  return environment
}

/** One variable as children see it. Windows names are case-insensitive (PATH is usually spelled `Path`). */
export function childEnvVariable(name: string): string | undefined {
  return process.platform === 'win32' ? process.env[name] : childBaseEnv()[name]
}
