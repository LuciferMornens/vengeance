// Memory and CPU of one app's process tree, counted the way Task Manager counts it: the "Memory" column is each
// process's private working set, and the app group is their sum. Read-only: it never touches a process.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HUNDRED_NS_PER_MS = 10_000

const SCRIPT = [
  '$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,KernelModeTime,UserModeTime,@{n="Created";e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}}',
  '$w = Get-CimInstance Win32_PerfRawData_PerfProc_Process | Select-Object IDProcess,WorkingSetPrivate,WorkingSet,PrivateBytes',
  '@{ processes = $p; memory = $w } | ConvertTo-Json -Compress -Depth 3'
].join('; ')

/** Process kind from its image and Chromium `--type` switch: browser (main), gpu, renderer, utility:<sub>, engine… */
export function processKind(name, commandLine) {
  const image = name.toLowerCase()
  // The hosts can run under a node.exe override, so they are told apart before the engine; their JSON argument
  // reaches the command line Windows-quoted (`{\"role\":\"extensions\"}`).
  if (/\bprovider-host\.js\b/.test(commandLine)) {
    return /\brole\\*"?\s*:\s*\\*"?extensions\b/.test(commandLine)
      ? 'utility:vengeance.provider-host'
      : 'utility:vengeance.sdk-host'
  }
  if (image === 'node.exe' || /--mode\s+rpc\b/.test(commandLine)) return 'engine'
  if (image === 'prime-agent.exe') return 'engine2'
  if (image === 'conhost.exe') return 'conhost'
  const type = /--type=([\w-]+)/.exec(commandLine)?.[1]
  if (!type) return 'browser'
  if (type === 'utility')
    return `utility:${/--utility-sub-type=([\w.]+)/.exec(commandLine)?.[1] ?? 'unknown'}`
  return type
}

async function snapshot() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', SCRIPT], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  })
  let parsed
  try {
    // Command lines can hold raw control characters.
    // eslint-disable-next-line no-control-regex
    parsed = JSON.parse(stdout.replace(/[\x00-\x1f]/g, ' '))
  } catch (error) {
    throw new Error(`Process table was not JSON: ${error.message}`)
  }
  const memory = new Map(parsed.memory.map((row) => [row.IDProcess, row]))
  return parsed.processes.map((row) => {
    const mem = memory.get(row.ProcessId)
    return {
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      name: row.Name ?? '',
      commandLine: row.CommandLine ?? '',
      createdMs: Number(row.Created ?? 0),
      cpuMs: (Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0)) / HUNDRED_NS_PER_MS,
      privateWs: Number(mem?.WorkingSetPrivate ?? 0),
      workingSet: Number(mem?.WorkingSet ?? 0),
      privateBytes: Number(mem?.PrivateBytes ?? 0)
    }
  })
}

/** `root` and its live descendants (a child is never older than its parent, so reused PIDs are skipped). */
function tree(table, root) {
  const rootRow = table.find((row) => row.pid === root)
  if (!rootRow) return []
  const out = [rootRow]
  const queue = [rootRow]
  while (queue.length) {
    const parent = queue.shift()
    for (const row of table) {
      if (row.ppid === parent.pid && row.pid !== parent.pid && row.createdMs >= parent.createdMs) {
        out.push(row)
        queue.push(row)
      }
    }
  }
  return out
}

/**
 * One reading of `rootPid`'s tree: every process with its kind, private working set (bytes), working set and CPU
 * time so far (ms). `app` totals cover the Electron processes Task Manager groups under the app; `engines` the Engine
 * processes it starts.
 */
export async function sampleTree(rootPid) {
  const rows = tree(await snapshot(), rootPid).map((row) => ({
    ...row,
    kind: processKind(row.name, row.commandLine)
  }))
  const isEngine = (row) =>
    row.kind === 'engine' || row.kind === 'engine2' || row.kind === 'conhost'
  const sum = (list, field) => list.reduce((total, row) => total + row[field], 0)
  const app = rows.filter((row) => !isEngine(row))
  const engines = rows.filter(isEngine)
  return {
    at: Date.now(),
    processes: rows.map(({ pid, kind, privateWs, workingSet, privateBytes, cpuMs }) => ({
      pid,
      kind,
      privateWs,
      workingSet,
      privateBytes,
      cpuMs
    })),
    app: { count: app.length, privateWs: sum(app, 'privateWs'), cpuMs: sum(app, 'cpuMs') },
    engines: {
      count: engines.length,
      privateWs: sum(engines, 'privateWs'),
      cpuMs: sum(engines, 'cpuMs')
    },
    total: {
      count: rows.length,
      privateWs: sum(rows, 'privateWs'),
      cpuMs: sum(rows, 'cpuMs')
    }
  }
}

/** Private working set per kind (bytes), summed when a kind has several processes. */
export function byKind(sample) {
  const out = {}
  for (const row of sample.processes) out[row.kind] = (out[row.kind] ?? 0) + row.privateWs
  return out
}

export const MiB = 1024 * 1024
export const mib = (bytes) => Math.round((bytes / MiB) * 10) / 10
