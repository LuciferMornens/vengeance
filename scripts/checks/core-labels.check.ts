import { strict as assert } from 'node:assert'
import { parseEngineHelp } from '../../src/main/features/launch/flags'
import { packageDisplayName, packageLabel } from '../../src/main/features/settings/package-source'
import { cliStatusLine } from '../../src/main/features/settings/pi-cli'
import { pruneBashRuns, MAX_BASH_RUNS } from '../../src/renderer/store/agent-reducer'
import type { BashRun, TranscriptEntry } from '../../src/renderer/store/agent-state'
import { isInside, samePath } from '../../src/main/paths'
import { check } from './harness'

await check('cliStatusLine (N4): friendly status lines, never the engine command', () => {
  assert.equal(cliStatusLine(['install', 'npm:pi-web-access', '-l', '--approve']), 'Installing Web access…')
  assert.equal(cliStatusLine(['remove', 'git:github.com/paoloanzn/pi-black']), 'Removing Black…')
  assert.equal(cliStatusLine(['update', '--self', '--force']), 'Updating engine…')
  assert.equal(cliStatusLine(['update', '--all']), 'Updating engine and extensions…')
  assert.equal(cliStatusLine(['update', '--extensions']), 'Updating extensions…')
  assert.equal(cliStatusLine(['update', '--models']), 'Refreshing model catalogs…')
  assert.equal(cliStatusLine(['update', 'npm:@juicesharp/rpiv-todo']), 'Updating Rpiv todo…')
  assert.equal(cliStatusLine(['mcp', 'login', 'sentry']), 'Signing in to sentry…')
  for (const args of [['install', 'npm:pi-lens'], ['update', '--self'], ['mcp', 'logout', 'x'], ['unknown']]) {
    assert.equal(/\bpi\b|\$/.test(cliStatusLine(args)), false, args.join(' '))
  }
})

await check('package labels (N10): one technical name, one friendly label', () => {
  assert.equal(packageDisplayName('npm:@scope/pi-web-access@1.2.0'), '@scope/pi-web-access')
  assert.equal(packageDisplayName('git:github.com/paoloanzn/pi-black@v1'), 'github.com/paoloanzn/pi-black')
  assert.equal(packageLabel('npm:@scope/pi-web-access@1.2.0'), 'Web access')
  assert.equal(packageLabel('npm:pi-lens'), 'Lens')
})

await check('parseEngineHelp: flag groups keep the technical name and gain a friendly label', () => {
  const help = 'Extension CLI Flags:\n  --no-lens                   Start pi-lens disabled.\n  --todo-strict               Require rpiv-todo items to be closed.\n'
  const { flags } = parseEngineHelp(help, ['npm:pi-lens', 'npm:@juicesharp/rpiv-todo'])
  assert.deepEqual(
    flags.map((f) => [f.name, f.group, f.groupLabel]),
    [
      ['no-lens', 'pi-lens', 'Lens'],
      ['todo-strict', 'rpiv-todo', 'Rpiv todo']
    ]
  )
})

await check('main paths (N10): case-insensitive on Windows, separator-agnostic', () => {
  const win = process.platform === 'win32'
  assert.equal(isInside(win ? 'D:\\proj' : '/proj', win ? 'd:/PROJ/src/a.ts' : '/proj/src/a.ts'), true)
  assert.equal(isInside(win ? 'D:\\proj' : '/proj', win ? 'D:\\project\\a.ts' : '/project/a.ts'), false)
  assert.equal(samePath(win ? 'D:\\proj\\' : '/proj/', win ? 'd:/proj' : '/proj'), true)
})

const bashEntry = (command: string, timestamp: number): TranscriptEntry => ({
  key: `b${timestamp}`,
  message: { role: 'bashExecution', command, output: '', exitCode: 0, cancelled: false, truncated: false, timestamp }
})
const run = (id: string, command: string, startedAt: number, running = false): BashRun => ({ id, command, output: '', running, startedAt })

await check('pruneBashRuns (N19): landed runs go, pending and running stay, finished runs are capped', () => {
  const bash = { a: run('a', 'ls', 1000), b: run('b', 'pwd', 2000), c: run('c', 'sleep 9', 3000, true) }
  const pruned = pruneBashRuns(bash, [bashEntry('ls', 1500)])
  assert.deepEqual(Object.keys(pruned).sort(), ['b', 'c'])
  assert.equal(pruneBashRuns(pruned, []), pruned, 'unchanged state keeps its identity')
  const many = Object.fromEntries(Array.from({ length: MAX_BASH_RUNS + 5 }, (_, i) => [`r${i}`, run(`r${i}`, `echo ${i}`, i)]))
  const capped = pruneBashRuns({ ...many, live: run('live', 'watch', -1, true) }, [])
  assert.equal(Object.keys(capped).length, MAX_BASH_RUNS + 1)
  assert.equal(capped.r0, undefined)
  assert.ok(capped.live)
})
