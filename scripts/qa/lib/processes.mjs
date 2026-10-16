// Windows process inspection for QA: liveness, the descendant tree of a process the harness started
// (orphan checks on quit), and killing only trees the harness owns.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TASKKILL_TIMEOUT_MS = 10_000

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Kill a process tree the harness started (never call it with a PID the harness did not spawn). */
export async function killTree(pid) {
  const taskkill = execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    timeout: TASKKILL_TIMEOUT_MS
  })
  await Promise.race([taskkill.catch(() => undefined), sleep(TASKKILL_TIMEOUT_MS)])
  if (isAlive(pid)) {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
  }
}

/** PIDs of every running `<imageName>` (e.g. Vengeance.exe). */
export async function pidsOfImage(imageName) {
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

/** Every Windows process: { pid, ppid, name, commandLine, workingSetBytes, createdMs }. */
export async function processTable() {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,@{n="Created";e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    maxBuffer: 64 * 1024 * 1024,
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
