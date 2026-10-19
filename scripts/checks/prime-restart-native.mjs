import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executableName } from '../qa/lib/platform.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const executable = join(
  root,
  'resources',
  'prime-auth',
  'bin',
  executableName('vengeance-prime-auth')
)
const tempRoot = await mkdtemp(join(tmpdir(), 'vengeance-prime-restart-'))
const agentDir = join(tempRoot, 'agent')
const socketPath = join(tempRoot, 'supervisor.sock')
const sessionPath = join(tempRoot, 'sessions', 'first.jsonl')
const secondSessionPath = join(tempRoot, 'sessions', 'second.jsonl')
const rosterPath = join(tempRoot, 'prepared', 'roster.json')
const backupDir = join(tempRoot, 'restart-backup')
const descriptorDir = join(
  agentDir,
  'daemon-workers',
  createHash('sha256').update(socketPath).digest('hex').slice(0, 12)
)
const descriptorPath = join(descriptorDir, 'worker-a.json')
const secondDescriptorPath = join(descriptorDir, 'worker-b.json')
const sessionBytes = Buffer.from('{"type":"session","id":"fixture-a"}\n')
const residentSelections = {
  'active-a': { sessionPath, provider: 'live-provider', model: 'live-model', thinking: 'medium' },
  'active-b': {
    sessionPath: secondSessionPath,
    provider: 'peer-provider',
    model: 'peer-model',
    thinking: 'xhigh'
  }
}

async function processStartId() {
  if (process.platform === 'linux') {
    const stat = await readFile(join('/proc', String(process.pid), 'stat'), 'utf8')
    const startTimeFieldIndex = 19
    return `proc:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[startTimeFieldIndex]}`
  }
  const command = process.platform === 'win32' ? 'powershell.exe' : 'ps'
  const arguments_ =
    process.platform === 'win32'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`
        ]
      : ['-p', String(process.pid), '-o', 'lstart=']
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, LC_ALL: 'C', LC_TIME: 'C', LANG: 'C', TZ: 'UTC' }
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const value = result.stdout.trim()
  assert.ok(value)
  return `${process.platform === 'win32' ? 'win' : 'ps'}:${value}`
}

function descriptor(workerId, activeSessionId, sessionFile) {
  return {
    version: 2,
    workerId,
    pid: process.pid,
    socketPath: join(tempRoot, `${workerId}.sock`),
    recoveryJournalPath: join(tempRoot, `${workerId}.journal`),
    orphanProcessJournalPath: join(tempRoot, `${workerId}.orphan-journal`),
    supervisorSocketPath: socketPath,
    authenticationToken: `fixture-${workerId}`,
    rootActiveSessionId: activeSessionId,
    sessionFile,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-01T12:00:00Z',
    lifecycle: 'ready',
    createCommand: {
      sessionPath: sessionFile,
      cwd: tempRoot,
      provider: 'old-provider',
      model: 'old-model',
      thinking: 'low',
      config: { provider: 'old-provider', model: 'old-model', thinking: 'low', extra: 'keep' },
      futureCreateField: { preserved: true }
    },
    consecutiveFailures: 0,
    futureDescriptorField: { preserved: true }
  }
}

function rosterSession(sessionId, activeSessionId, sessionFile) {
  return {
    session_id: sessionId,
    active_session_id: activeSessionId,
    session_file: sessionFile,
    kind: 'top-level',
    rlm_depth: 0,
    cwd: tempRoot,
    runtime_config: {
      create: {
        sessionPath: sessionFile,
        cwd: tempRoot,
        provider: 'old-provider',
        model: 'old-model',
        thinking: 'low',
        config: { provider: 'old-provider', model: 'old-model', thinking: 'low', extra: 'keep' },
        futureCreateField: { preserved: true }
      },
      futureRuntimeField: 'preserved'
    },
    queue: { next_turn: [], actions: {} },
    in_flight: {
      streaming: false,
      compacting: false,
      bash_running: false,
      rlm_children: false,
      retrying: false,
      prompt_in_flight: false
    },
    should_resume: false,
    futureSessionField: { preserved: true }
  }
}

function callHelper(operation, overrides = {}) {
  const request = {
    operation,
    agentDir,
    socketPath,
    nativeAgentId: 'active-a',
    sessionPath,
    rosterPath,
    backupDir,
    configPatch: {
      provider: null,
      model: 'new-model',
      thinking: 'high',
      systemPrompt: 'fixture system'
    },
    residentSelections,
    ...overrides
  }
  const child = spawnSync(executable, ['--restart-config'], {
    cwd: tempRoot,
    env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    input: JSON.stringify(request),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  const output = JSON.parse(child.stdout.trim())
  assert.ok(!JSON.stringify(output).includes('fixture system'))
  return output
}

try {
  await mkdir(descriptorDir, { recursive: true })
  await mkdir(dirname(sessionPath), { recursive: true })
  await mkdir(dirname(rosterPath), { recursive: true })
  await writeFile(sessionPath, sessionBytes)
  await writeFile(secondSessionPath, Buffer.from('{"type":"session","id":"fixture-b"}\n'))

  const firstDescriptor = descriptor('worker-a', 'active-a', sessionPath)
  const secondDescriptor = descriptor('worker-b', 'active-b', secondSessionPath)
  const startId = await processStartId()
  firstDescriptor.processStartId = startId
  secondDescriptor.processStartId = startId
  const departed = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    }
  )
  assert.equal(departed.error, undefined)
  assert.equal(departed.status, 0, departed.stderr)
  const terminalDescriptor = {
    ...descriptor('worker-c', 'active-c', join(tempRoot, 'imported.jsonl')),
    pid: Number(departed.stdout),
    stopRequestedAt: '2026-10-01T12:01:00Z'
  }
  const roster = {
    format_version: 1,
    update_id: '018f1234-abcd-7abc-8def-0123456789ab',
    socket_path: socketPath,
    created_at: '2026-10-01T12:00:00Z',
    supervisor: { pid: 4242, generation: 'fixture-generation' },
    binary: { from_version: '0.10.0', to_version: '0.10.1' },
    sessions: [
      rosterSession('session-a', 'active-a', sessionPath),
      rosterSession('session-b', 'active-b', secondSessionPath)
    ],
    workers: [
      { worker_id: 'worker-a', sessions: ['session-a'], launch_env: {}, futureWorkerField: 'a' },
      { worker_id: 'worker-b', sessions: ['session-b'], launch_env: {}, futureWorkerField: 'b' }
    ],
    futureRosterField: { preserved: true }
  }
  await writeFile(descriptorPath, JSON.stringify(firstDescriptor, null, 2))
  await writeFile(secondDescriptorPath, JSON.stringify(secondDescriptor, null, 2))
  await writeFile(rosterPath, JSON.stringify(roster, null, 2))
  const journals = [firstDescriptor, secondDescriptor].flatMap((worker) => [
    [worker.recoveryJournalPath, Buffer.from(`recovery-${worker.workerId}\0opaque`)],
    [worker.orphanProcessJournalPath, Buffer.from(`orphan-${worker.workerId}\0opaque`)]
  ])
  const absentJournalPath = secondDescriptor.orphanProcessJournalPath
  const presentJournals = journals.filter(([path]) => path !== absentJournalPath)
  for (const [path, bytes] of presentJournals) await writeFile(path, bytes)

  const originalDescriptor = await readFile(descriptorPath)
  const originalSecondDescriptor = await readFile(secondDescriptorPath)
  const originalRoster = await readFile(rosterPath)
  const originalSecondSession = await readFile(secondSessionPath)

  const siblingPath = join(descriptorDir, 'worker-c.json')
  for (const invalid of [
    '{',
    JSON.stringify({ ...descriptor('worker-c', 'active-c', secondSessionPath), version: 999 }),
    JSON.stringify({
      ...descriptor('worker-c', 'active-c', secondSessionPath),
      supervisorSocketPath: join(tempRoot, 'wrong-supervisor.sock')
    })
  ]) {
    await writeFile(siblingPath, invalid)
    const unsafe = callHelper('inspect')
    assert.equal(unsafe.ok, false)
    assert.equal(callHelper('workers').ok, false)
    assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
    assert.deepEqual(await readFile(rosterPath), originalRoster)
    assert.deepEqual(await readFile(sessionPath), sessionBytes)
    await rm(siblingPath)
  }

  for (const unsafeDescriptor of [
    { ...terminalDescriptor, stopRequestedAt: undefined },
    { ...terminalDescriptor, pid: process.pid, processStartId: startId },
    { ...terminalDescriptor, pid: process.pid },
    { ...terminalDescriptor, pid: process.pid, processStartId: 'unreadable' },
    { ...terminalDescriptor, workerId: 'worker-a' },
    { ...terminalDescriptor, rootActiveSessionId: 'active-a' }
  ]) {
    await writeFile(siblingPath, JSON.stringify(unsafeDescriptor))
    assert.equal(callHelper('capture').ok, false, 'unverified extra workers block capture')
    assert.equal(existsSync(backupDir), false)
    assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
    assert.deepEqual(await readFile(rosterPath), originalRoster)
    if (unsafeDescriptor.pid === process.pid && !unsafeDescriptor.processStartId) {
      assert.equal(callHelper('workers').ok, false, 'unknown owners cannot become wait targets')
    }
  }
  await writeFile(siblingPath, JSON.stringify(terminalDescriptor, null, 2))
  const originalTerminalDescriptor = await readFile(siblingPath)
  for (const journalPath of [
    terminalDescriptor.recoveryJournalPath,
    terminalDescriptor.orphanProcessJournalPath
  ]) {
    const bytes = Buffer.from(`terminal-${journalPath}`)
    await writeFile(journalPath, bytes)
    presentJournals.push([journalPath, bytes])
  }

  const wrongIdentity = callHelper('inspect', { nativeAgentId: 'missing-native-identity' })
  assert.equal(wrongIdentity.ok, false)
  assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
  assert.deepEqual(await readFile(rosterPath), originalRoster)
  assert.deepEqual(await readFile(sessionPath), sessionBytes)

  const inspected = callHelper('inspect')
  assert.equal(inspected.ok, true, JSON.stringify(inspected))
  assert.equal(inspected.result.descriptorPath, descriptorPath)
  assert.equal(inspected.result.workerId, 'worker-a')
  assert.deepEqual(inspected.result.workerPids, [process.pid])
  assert.deepEqual(callHelper('workers').result.workerPids, [process.pid])
  assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
  assert.deepEqual(await readFile(rosterPath), originalRoster)

  for (const invalidSelections of [
    undefined,
    {},
    { 'active-a': residentSelections['active-a'] },
    { ...residentSelections, 'active-b': { ...residentSelections['active-b'], model: '' } },
    {
      ...residentSelections,
      'active-b': { ...residentSelections['active-b'], thinking: 'unknown' }
    },
    {
      ...residentSelections,
      'active-b': { ...residentSelections['active-b'], provider: undefined }
    },
    { ...residentSelections, 'active-b': { ...residentSelections['active-b'], sessionPath } },
    { 'active-a': residentSelections['active-a'], unmatched: residentSelections['active-b'] },
    { ...residentSelections, unmatched: residentSelections['active-b'] }
  ]) {
    const refused = callHelper('capture', { residentSelections: invalidSelections })
    assert.equal(refused.ok, false)
    assert.equal(existsSync(backupDir), false, 'invalid captures create no destructive checkpoint')
    assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
    assert.deepEqual(await readFile(secondDescriptorPath), originalSecondDescriptor)
    assert.deepEqual(await readFile(rosterPath), originalRoster)
  }
  const duplicateRoster = structuredClone(roster)
  duplicateRoster.sessions[1].active_session_id = 'active-a'
  await writeFile(rosterPath, JSON.stringify(duplicateRoster))
  assert.equal(callHelper('capture').ok, false)
  assert.equal(existsSync(backupDir), false)
  await writeFile(rosterPath, originalRoster)

  for (const invalidCreate of [
    undefined,
    'invalid-create',
    {
      ...roster.sessions[1].runtime_config.create,
      config: 'invalid-config'
    }
  ]) {
    const invalidRoster = structuredClone(roster)
    invalidRoster.sessions[1].runtime_config.create = invalidCreate
    await writeFile(rosterPath, JSON.stringify(invalidRoster))
    assert.equal(callHelper('capture').ok, false, 'all peer creates are preflighted before capture')
    assert.equal(existsSync(backupDir), false)
    assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
    assert.deepEqual(await readFile(secondDescriptorPath), originalSecondDescriptor)
  }
  await writeFile(rosterPath, originalRoster)
  const invalidPeer = structuredClone(secondDescriptor)
  invalidPeer.createCommand.config = 'invalid-config'
  await writeFile(secondDescriptorPath, JSON.stringify(invalidPeer))
  assert.equal(callHelper('capture').ok, false)
  assert.equal(existsSync(backupDir), false)
  assert.deepEqual(await readFile(rosterPath), originalRoster)
  await writeFile(secondDescriptorPath, originalSecondDescriptor)

  async function assertPeerSelection() {
    const peerDescriptor = JSON.parse(await readFile(secondDescriptorPath, 'utf8'))
    const peerRoster = JSON.parse(await readFile(rosterPath, 'utf8')).sessions[1]
    for (const create of [peerDescriptor.createCommand, peerRoster.runtime_config.create]) {
      for (const fields of [create, create.config]) {
        assert.equal(fields.provider, 'peer-provider')
        assert.equal(fields.model, 'peer-model')
        assert.equal(fields.thinking, 'xhigh')
        assert.equal('systemPrompt' in fields, false, 'target launch options cannot leak to peers')
      }
      assert.deepEqual(create.futureCreateField, { preserved: true })
    }
    assert.deepEqual(peerDescriptor.futureDescriptorField, { preserved: true })
    assert.deepEqual(peerRoster.futureSessionField, { preserved: true })
    assert.equal(peerRoster.runtime_config.futureRuntimeField, 'preserved')
  }

  const patched = callHelper('patch')
  assert.equal(patched.ok, true, JSON.stringify(patched))
  assert.deepEqual(patched.result.workerPids, [process.pid])
  const patchedDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
  const patchedRoster = JSON.parse(await readFile(rosterPath, 'utf8'))
  const descriptorCreate = patchedDescriptor.createCommand
  const rosterCreate = patchedRoster.sessions[0].runtime_config.create
  for (const create of [descriptorCreate, rosterCreate]) {
    assert.equal(create.model, 'new-model')
    assert.equal(create.thinking, 'high')
    assert.equal(create.systemPrompt, 'fixture system')
    assert.equal('provider' in create, false)
    assert.deepEqual(create.futureCreateField, { preserved: true })
    assert.equal(create.config.model, 'new-model')
    assert.equal(create.config.thinking, 'high')
    assert.equal(create.config.systemPrompt, 'fixture system')
    assert.equal('provider' in create.config, false)
    assert.equal(create.config.extra, 'keep')
  }
  assert.deepEqual(patchedDescriptor.futureDescriptorField, { preserved: true })
  assert.deepEqual(patchedRoster.futureRosterField, { preserved: true })
  assert.deepEqual(patchedRoster.sessions[0].futureSessionField, { preserved: true })
  await assertPeerSelection()
  assert.deepEqual(await readFile(sessionPath), sessionBytes)
  assert.deepEqual(await readFile(secondSessionPath), originalSecondSession)
  assert.deepEqual(await readFile(join(backupDir, 'descriptor.json')), originalDescriptor)
  assert.deepEqual(await readFile(join(backupDir, 'roster.json')), originalRoster)

  const rolledBack = callHelper('rollback')
  assert.equal(rolledBack.ok, true, JSON.stringify(rolledBack))
  assert.equal(rolledBack.result.restored, true)
  assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
  assert.deepEqual(await readFile(rosterPath), originalRoster)
  assert.deepEqual(await readFile(sessionPath), sessionBytes)
  assert.deepEqual(await readFile(secondDescriptorPath), originalSecondDescriptor)
  assert.deepEqual(await readFile(siblingPath), originalTerminalDescriptor)
  for (const [path, bytes] of presentJournals) assert.deepEqual(await readFile(path), bytes)
  assert.equal(existsSync(absentJournalPath), false)

  const captureBackupDir = join(tempRoot, 'capture-backup')
  const captured = callHelper('capture', { backupDir: captureBackupDir })
  assert.equal(captured.ok, true, JSON.stringify(captured))
  assert.deepEqual(captured.result.workerPids, [process.pid])
  const manifest = JSON.parse(await readFile(join(captureBackupDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.workers.length, 3)
  assert.deepEqual(
    manifest.workers.map((worker) => worker.journals.length),
    [2, 2, 2]
  )
  assert.equal(
    manifest.workers
      .flatMap((worker) => worker.journals)
      .filter((journal) => journal.fileName === null).length,
    1
  )
  for (const [path] of presentJournals) await rm(path)
  await rm(descriptorPath)
  await rm(secondDescriptorPath)
  await rm(siblingPath)
  await writeFile(absentJournalPath, Buffer.from('successor-only-journal'))
  assert.deepEqual(callHelper('workers', { backupDir: captureBackupDir }).result.workerPids, [])
  const [startKind, startValue] = startId.split(':')
  const recycledStartId =
    startKind === 'ps' ? 'ps:Thu Jan  1 00:00:00 1970' : `${startKind}:${BigInt(startValue) + 1n}`
  await writeFile(
    siblingPath,
    JSON.stringify({ ...terminalDescriptor, pid: process.pid, processStartId: recycledStartId })
  )
  assert.deepEqual(
    callHelper('workers', { backupDir: captureBackupDir }).result.workerPids,
    [],
    'a reused PID must not be polled as a worker belonging to the stopped engine'
  )
  await rm(siblingPath)

  const restoredAndPatched = callHelper('patch', { backupDir: captureBackupDir })
  assert.equal(restoredAndPatched.ok, true, JSON.stringify(restoredAndPatched))
  assert.deepEqual(restoredAndPatched.result.workerPids, [process.pid])
  assert.deepEqual(await readFile(siblingPath), originalTerminalDescriptor)
  assert.equal(JSON.parse(await readFile(descriptorPath, 'utf8')).createCommand.model, 'new-model')
  assert.equal(
    JSON.parse(await readFile(rosterPath, 'utf8')).sessions[0].runtime_config.create.model,
    'new-model'
  )
  await assertPeerSelection()
  for (const [path, bytes] of presentJournals) assert.deepEqual(await readFile(path), bytes)
  assert.equal(existsSync(absentJournalPath), false)
  assert.deepEqual(await readFile(sessionPath), sessionBytes)
  assert.deepEqual(await readFile(secondSessionPath), originalSecondSession)

  const restoredCapture = callHelper('rollback', { backupDir: captureBackupDir })
  assert.equal(restoredCapture.ok, true, JSON.stringify(restoredCapture))
  assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
  assert.deepEqual(await readFile(secondDescriptorPath), originalSecondDescriptor)
  assert.deepEqual(await readFile(siblingPath), originalTerminalDescriptor)
  assert.deepEqual(await readFile(rosterPath), originalRoster)
  for (const [path, bytes] of presentJournals) assert.deepEqual(await readFile(path), bytes)
  assert.equal(existsSync(absentJournalPath), false)
  assert.deepEqual(await readFile(sessionPath), sessionBytes)
  const recovery = callHelper('patch', { backupDir: captureBackupDir, configPatch: {} })
  assert.equal(recovery.ok, true, JSON.stringify(recovery))
  const recovered = JSON.parse(await readFile(descriptorPath, 'utf8')).createCommand
  assert.equal(recovered.provider, 'live-provider')
  assert.equal(recovered.model, 'live-model')
  assert.equal(recovered.thinking, 'medium')
  assert.equal(
    'systemPrompt' in recovered,
    false,
    'failed target options are excluded from recovery'
  )
  await assertPeerSelection()
  assert.deepEqual(await readFile(join(captureBackupDir, 'descriptor.json')), originalDescriptor)
  assert.deepEqual(await readFile(join(captureBackupDir, 'roster.json')), originalRoster)
  assert.equal(callHelper('rollback', { backupDir: captureBackupDir }).ok, true)
  assert.deepEqual(await readFile(descriptorPath), originalDescriptor)
  assert.deepEqual(await readFile(secondDescriptorPath), originalSecondDescriptor)
  console.log(
    'Native restart validated live selections and terminal owners; peer choices and rollback recovery passed'
  )
} finally {
  const resolvedTempRoot = await realpath(tempRoot)
  const resolvedSystemTemp = await realpath(tmpdir())
  assert.ok(relative(resolvedSystemTemp, resolvedTempRoot).split(sep)[0] !== '..')
  await rm(resolvedTempRoot, { recursive: true, force: true })
}
