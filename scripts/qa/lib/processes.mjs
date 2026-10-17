// Process inspection for QA: liveness, the descendant tree of a process the harness started
// (orphan checks on quit), and killing only trees the harness owns. Windows asks tasklist, taskkill
// and CIM; Linux reads /proc; macOS asks ps.
import { execFile } from 'node:child_process'
import { readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TASKKILL_TIMEOUT_MS = 10_000
/** POSIX: SIGTERM first (Electron and the engines shut down their children), SIGKILL after this. */
const TERM_GRACE_MS = 3_000
const POLL_MS = 50
const PROCESS_INSPECTION_TIMEOUT_MS = 10_000
const PS_MAX_BUFFER = 64 * 1024 * 1024
/** /proc/<pid>/stat counts in USER_HZ: 100 on every architecture Vengeance ships (x64, arm64). */
const LINUX_TICKS_PER_SECOND = 100

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name)
  } catch {
    // Already gone.
  }
}

/** Kill a process tree the harness started (never call it with a PID the harness did not spawn). */
export async function killTree(pid) {
  if (process.platform !== 'win32') {
    const tree = [pid, ...descendants(await processTable(), pid).map((proc) => proc.pid)]
    for (const id of tree) signal(id, 'SIGTERM')
    const deadline = Date.now() + TERM_GRACE_MS
    while (tree.some(isAlive) && Date.now() < deadline) await sleep(POLL_MS)
    for (const id of tree) if (isAlive(id)) signal(id, 'SIGKILL')
    return
  }
  const taskkill = execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    timeout: TASKKILL_TIMEOUT_MS
  })
  await Promise.race([taskkill.catch(() => undefined), sleep(TASKKILL_TIMEOUT_MS)])
  if (isAlive(pid)) signal(pid, 'SIGTERM')
}

/** PIDs of every running `<imageName>` (e.g. platform.mjs APP_PROCESS_NAME). */
export async function pidsOfImage(imageName) {
  if (process.platform !== 'win32') {
    return (await processTable()).filter((proc) => proc.name === imageName).map((proc) => proc.pid)
  }
  const { stdout } = await execFileAsync('tasklist', [
    '/FI',
    `IMAGENAME eq ${imageName}`,
    '/FO',
    'CSV',
    '/NH'
  ])
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split('","')[1])
    .filter(Boolean)
    .map(Number)
}

/** `pid (comm) state ppid …` → [comm, fields from state on]; comm may hold spaces and parens. */
function linuxStat(stat) {
  const close = stat.lastIndexOf(')')
  return [stat.slice(stat.indexOf('(') + 1, close), stat.slice(close + 2).split(' ')]
}

/** The executable behind /proc/<pid>/exe (null for kernel threads and other users' processes). */
async function linuxExecutable(pid) {
  const target = await readlink(join('/proc', String(pid), 'exe')).catch(() => null)
  return target?.replace(/ \(deleted\)$/, '') ?? null
}

async function linuxProcess(pid, bootMs) {
  const dir = join('/proc', String(pid))
  const [stat, cmdline, status, executable] = await Promise.all([
    readFile(join(dir, 'stat'), 'utf8'),
    readFile(join(dir, 'cmdline'), 'utf8'),
    readFile(join(dir, 'status'), 'utf8'),
    linuxExecutable(pid)
  ])
  const [comm, fields] = linuxStat(stat)
  // fields[n] is stat field n + 3 (proc(5)): 4 ppid, 22 starttime.
  return {
    pid,
    ppid: Number(fields[1]),
    name: executable ? basename(executable) : comm,
    commandLine: cmdline.replace(/\0+$/, '').split('\0').join(' '),
    workingSetBytes: Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1] ?? 0) * 1024,
    createdMs: bootMs + (Number(fields[19]) * 1000) / LINUX_TICKS_PER_SECOND
  }
}

async function linuxProcessTable() {
  const bootSeconds = /^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))?.[1]
  if (!bootSeconds) throw new Error('/proc/stat has no boot time')
  const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number)
  // A process can exit between the listing and its reads: it is simply not in the snapshot.
  const entries = await Promise.all(
    pids.map((pid) => linuxProcess(pid, Number(bootSeconds) * 1000).catch(() => null))
  )
  return entries.filter(Boolean)
}

function ps(args) {
  // The C locale keeps the columns parseable whatever the runner's language is.
  return execFileAsync('ps', args, {
    maxBuffer: PS_MAX_BUFFER,
    timeout: PROCESS_INSPECTION_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C' }
  }).then(({ stdout }) => stdout.split('\n'))
}

/** ps `etime`, `[[dd-]hh:]mm:ss`, in seconds. */
function elapsedSeconds(etime) {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const [seconds = 0, minutes = 0, hours = 0] = clock.split(':').map(Number).reverse()
  return ((Number(days) * 24 + hours) * 60 + minutes) * 60 + seconds
}

async function macProcessTable() {
  // Both the command (args) and the executable (comm) may hold spaces, so each is the last column
  // of its own listing; a process that started or exited between the two is left out.
  const now = Date.now()
  const [rows, comms] = await Promise.all([
    ps(['-A', '-ww', '-o', 'pid=,ppid=,rss=,etime=,args=']),
    ps(['-A', '-ww', '-o', 'pid=,comm='])
  ])
  const names = new Map()
  for (const line of comms) {
    const match = /^\s*(\d+) +(.*)$/.exec(line)
    if (match) names.set(Number(match[1]), basename(match[2].trim()))
  }
  const table = []
  for (const line of rows) {
    const match = /^\s*(\d+) +(\d+) +(\d+) +(\S+) ?(.*)$/.exec(line)
    const pid = Number(match?.[1])
    if (!match || !names.has(pid)) continue
    table.push({
      pid,
      ppid: Number(match[2]),
      name: names.get(pid),
      commandLine: match[5],
      workingSetBytes: Number(match[3]) * 1024,
      createdMs: now - elapsedSeconds(match[4]) * 1000
    })
  }
  return table
}

async function windowsProcessTable() {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,@{n="Created";e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    maxBuffer: PS_MAX_BUFFER,
    windowsHide: true
  })
  // Command lines can hold raw control characters (e.g. a tab or newline in an argument).
  // eslint-disable-next-line no-control-regex
  return JSON.parse(stdout.replace(/[\x00-\x1f]/g, ' ')).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name,
    commandLine: p.CommandLine ?? '',
    workingSetBytes: Number(p.WorkingSetSize ?? 0),
    createdMs: Number(p.Created ?? 0)
  }))
}

/**
 * Every process: { pid, ppid, name, commandLine, workingSetBytes, createdMs }. `name` is the
 * executable's file name (Windows image name, e.g. `prime-agent.exe`; elsewhere `prime-agent`).
 */
export function processTable() {
  if (process.platform === 'win32') return windowsProcessTable()
  return process.platform === 'darwin' ? macProcessTable() : linuxProcessTable()
}

/**
 * Every live descendant of `pid` (from a processTable() snapshot). A child must be younger than its
 * parent: Windows keeps the ParentProcessId of orphans, so a reused PID would otherwise adopt them.
 */
export function descendants(table, pid) {
  const out = []
  const queue = [pid]
  const createdOf = (id) => table.find((proc) => proc.pid === id)?.createdMs ?? 0
  while (queue.length) {
    const current = queue.shift()
    for (const proc of table) {
      if (proc.ppid === current && proc.pid !== current && proc.createdMs >= createdOf(current)) {
        out.push(proc)
        queue.push(proc.pid)
      }
    }
  }
  return out
}

/** { pid, parentPid, executablePath } of one running process. */
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The native worker has no valid PID')
  const unknown = () => new Error(`Native process ${pid} could not be inspected`)
  if (process.platform === 'linux') {
    const stat = await readFile(join('/proc', String(pid), 'stat'), 'utf8').catch(() => null)
    const executablePath = await linuxExecutable(pid)
    if (!stat || !executablePath) throw unknown()
    return { pid, parentPid: Number(linuxStat(stat)[1][1]), executablePath }
  }
  if (process.platform === 'darwin') {
    // macOS `comm` is the path the process started from; resolve it like Windows' ExecutablePath.
    const [line] = await ps(['-ww', '-o', 'ppid=,comm=', '-p', String(pid)]).catch(() => [])
    const match = /^\s*(\d+) +(.+)$/.exec(line ?? '')
    if (!match || !isAbsolute(match[2].trim())) throw unknown()
    return {
      pid,
      parentPid: Number(match[1]),
      executablePath: await realpath(match[2].trim()).catch(() => match[2].trim())
    }
  }
  const script = [
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    'Select-Object ProcessId,ParentProcessId,ExecutablePath',
    'ConvertTo-Json -Compress'
  ].join(' | ')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    timeout: PROCESS_INSPECTION_TIMEOUT_MS
  })
  const record = JSON.parse(stdout)
  if (record?.ProcessId !== pid) throw unknown()
  return {
    pid: record.ProcessId,
    parentPid: record.ParentProcessId,
    executablePath: record.ExecutablePath
  }
}
