import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { ROOT, shutdownOwnedPrimeDaemons } from '../lib/app.mjs'
import { API, startFakeLlm } from '../lib/fake-llm.mjs'
import { processTable } from '../lib/processes.mjs'
import { tempRoot } from '../lib/tmp.mjs'

export const PRIME_PROVIDER = 'qa-prime'
export const PRIME_HEADER_VALUE = 'Bearer qa-prime-header-only'
export const PRIME_MODELS = Object.freeze({ reasoning: 'prime-qa', small: 'prime-qa-small' })

const AUTH_SAVE_TIMEOUT_MS = 15_000
const PRIME_API_KEY = 'qa-prime-local-only'
const PRIME_CONTEXT_WINDOW = 128_000
const PRIME_OUTPUT_LIMIT = 4096
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const SECRET_VARIABLE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i
const PRIME_VARIABLE = /^PRIME_AGENT_/
const executeFile = promisify(execFile)
const PROCESS_INSPECTION_TIMEOUT_MS = 10_000

export async function executableHash(executable) {
  const hash = createHash('sha256')
  const stream = createReadStream(executable)
  try {
    for await (const chunk of stream) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    stream.destroy()
  }
}

async function fixtureExecutable() {
  const candidatePath = process.env.QA_PRIME_EXECUTABLE
  if (candidatePath === undefined) {
    return {
      executable: await realpath(
        join(ROOT, '.engine-staging', 'bundled', 'prime', 'prime-agent.exe')
      ),
      candidate: null
    }
  }
  if (
    !candidatePath ||
    !isAbsolute(candidatePath) ||
    !candidatePath.toLowerCase().endsWith('.exe')
  ) {
    throw new Error('QA_PRIME_EXECUTABLE must be an absolute path to the candidate .exe')
  }
  const expectedHash = process.env.QA_PRIME_SHA256?.toLowerCase()
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('QA_PRIME_SHA256 is mandatory when QA_PRIME_EXECUTABLE is supplied')
  }
  const executable = await realpath(candidatePath)
  const actualHash = await executableHash(executable)
  if (actualHash !== expectedHash) {
    throw new Error(
      `Native candidate SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`
    )
  }
  return { executable, candidate: { executablePath: executable, sha256: actualHash } }
}

function sameExecutable(actual, expected) {
  return typeof actual === 'string' && resolve(actual).toLowerCase() === expected.toLowerCase()
}

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The native worker has no valid PID')
  const script = [
    `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    'Select-Object ProcessId,ParentProcessId,ExecutablePath',
    'ConvertTo-Json -Compress'
  ].join(' | ')
  const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    timeout: PROCESS_INSPECTION_TIMEOUT_MS
  })
  const record = JSON.parse(stdout)
  if (record?.ProcessId !== pid) throw new Error(`Native process ${pid} could not be inspected`)
  return {
    pid: record.ProcessId,
    parentPid: record.ParentProcessId,
    executablePath: record.ExecutablePath
  }
}

async function verifyCandidate(application, agentId, candidate, agentDirectory, foreignPids) {
  if (!candidate) return null
  const description = await application.invoke('engine:describe', 'prime')
  if (
    !description.found ||
    description.mock ||
    description.source !== 'override' ||
    !sameExecutable(description.cliPath, candidate.executablePath)
  ) {
    throw new Error('The public Engine 2 descriptor did not select the reviewed native candidate')
  }
  const descriptor = (await application.invoke('engine:list')).find(
    (entry) => entry.agentId === agentId && entry.engine === 'prime'
  )
  const worker = await processIdentity(descriptor?.pid)
  const daemon = await processIdentity(worker.parentPid)
  if (
    foreignPids.includes(worker.pid) ||
    foreignPids.includes(daemon.pid) ||
    !sameExecutable(worker.executablePath, candidate.executablePath) ||
    !sameExecutable(daemon.executablePath, candidate.executablePath)
  ) {
    throw new Error('The native worker or daemon is not the isolated reviewed candidate')
  }
  const registry = JSON.parse(
    await readFile(join(agentDirectory, 'vengeance-daemons.json'), 'utf8')
  )
  if (!Array.isArray(registry))
    throw new Error('The isolated native daemon registry is not an array')
  const record = registry.find((entry) =>
    sameExecutable(entry.executablePath, candidate.executablePath)
  )
  if (!record) throw new Error('The isolated native daemon registry did not record the candidate')
  const actualHash = await executableHash(candidate.executablePath)
  if (actualHash !== candidate.sha256)
    throw new Error('The candidate changed after its launch gate')
  return {
    ...candidate,
    description,
    worker,
    daemon,
    socketPath: record.socketPath
  }
}

function isolatedPrimeEnvironment(agentDirectory, kernelDirectory, executable) {
  const environment = {}
  for (const name of Object.keys(process.env)) {
    if (SECRET_VARIABLE.test(name) || PRIME_VARIABLE.test(name)) environment[name] = undefined
  }
  return {
    ...environment,
    PRIME_AGENT_CODING_AGENT_DIR: agentDirectory,
    PRIME_AGENT_SESSION_DIR: undefined,
    PRIME_AGENT_CODING_AGENT_SESSION_DIR: undefined,
    PRIME_AGENT_KERNEL_VENV: kernelDirectory,
    PRIME_AGENT_KERNEL_PYTHON: undefined,
    // Candidate packages remain byte-for-byte inspectable after Python imports their skills.
    PYTHONPYCACHEPREFIX: join(kernelDirectory, 'pycache'),
    PI_PACKAGE_DIR: undefined,
    VENGEANCE_PRIME_EXECUTABLE: executable,
    DO_NOT_TRACK: '1'
  }
}

export async function createEngineFixture() {
  const { executable, candidate } = await fixtureExecutable()
  const foreignPids = (await processTable()).map((entry) => entry.pid)
  const root = await tempRoot('vengeance-qa-engines-')
  let piServer
  let primeServer
  let piDirectory
  try {
    piServer = await startFakeLlm()
    primeServer = await startFakeLlm()
    piDirectory = await createAgentDir({ server: piServer })
    const sessionDirectory = root.path('prime-sessions')
    const primeDirectory = await root.folder('prime-agent', {
      'settings.json': {
        defaultProvider: PRIME_PROVIDER,
        defaultModel: PRIME_MODELS.reasoning,
        defaultThinkingLevel: 'off',
        sessionDir: sessionDirectory,
        telemetry: { enabled: false }
      },
      'models.json': {
        providers: {
          [PRIME_PROVIDER]: {
            api: API.openai,
            baseUrl: primeServer.openaiBaseUrl,
            apiKey: PRIME_API_KEY,
            headers: { Authorization: PRIME_HEADER_VALUE },
            models: Object.values(PRIME_MODELS).map((id) => ({
              id,
              name: id === PRIME_MODELS.reasoning ? 'Engine2 QA Reasoning' : 'Engine2 QA Small',
              api: API.openai,
              reasoning: true,
              input: ['text'],
              contextWindow: PRIME_CONTEXT_WINDOW,
              maxTokens: PRIME_OUTPUT_LIMIT,
              cost: ZERO_COST,
              headers: { Authorization: PRIME_HEADER_VALUE, 'X-QA-Secret': PRIME_HEADER_VALUE }
            }))
          }
        }
      }
    })
    const environment = isolatedPrimeEnvironment(
      primeDirectory,
      root.path('kernel-venv'),
      candidate ? executable : undefined
    )
    let cleaned = false
    let nativeStopped = false
    const stopNativeDaemon = async () => {
      if (nativeStopped) return
      await shutdownOwnedPrimeDaemons(primeDirectory, foreignPids)
      nativeStopped = true
    }

    return {
      root,
      piServer,
      primeServer,
      piDirectory,
      primeDirectory,
      sessionDirectory,
      environment,
      candidate,
      verifyPrimeExecutable(application, agentId) {
        return verifyCandidate(application, agentId, candidate, primeDirectory, foreignPids)
      },
      stopNativeDaemon,
      async cleanup() {
        if (cleaned) return
        cleaned = true
        try {
          await stopNativeDaemon()
        } finally {
          await piServer.close()
          await primeServer.close()
          await piDirectory.cleanup()
          await root.cleanup()
          if (candidate && (await executableHash(executable)) !== candidate.sha256) {
            throw new Error('The reviewed native candidate changed during the QA run')
          }
        }
      }
    }
  } catch (error) {
    await piServer?.close()
    await primeServer?.close()
    await piDirectory?.cleanup()
    await root.cleanup()
    throw error
  }
}

export function engineSettings(application, engine, channel, ...argumentsList) {
  return application.invoke('engine:settings', { engine, channel, args: argumentsList })
}

export async function storeApiKey(application, engine, providerId, value) {
  await application.page.evaluate(
    ([selectedEngine, selectedProvider, key, timeoutMs]) => {
      return new Promise((resolveLogin, rejectLogin) => {
        let loginId
        const timer = setTimeout(() => {
          unsubscribe()
          rejectLogin(new Error('Timed out saving the isolated provider key'))
        }, timeoutMs)
        const invokeSettings = (channel, args) =>
          window.vengeance.invoke('engine:settings', {
            engine: selectedEngine,
            channel,
            args
          })
        const unsubscribe = window.vengeance.on('settings:auth-event', (event) => {
          if ((event.engine ?? 'pi') !== selectedEngine) return
          if (loginId && event.loginId !== loginId) return
          if (event.kind === 'prompt') {
            loginId = event.loginId
            void invokeSettings('settings:auth-respond', [loginId, event.promptId, key]).catch(
              rejectLogin
            )
          } else if (event.kind === 'done') {
            clearTimeout(timer)
            unsubscribe()
            if (event.ok) resolveLogin()
            else rejectLogin(new Error(event.error ?? 'Provider key was not saved'))
          }
        })
        void invokeSettings('settings:auth-login', [
          {
            providerId: selectedProvider,
            method: 'api_key'
          }
        ])
          .then((identifier) => {
            loginId ??= identifier
          })
          .catch((error) => {
            clearTimeout(timer)
            unsubscribe()
            rejectLogin(error)
          })
      })
    },
    [engine, providerId, value, AUTH_SAVE_TIMEOUT_MS]
  )
}
