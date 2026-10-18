import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { executableName, hostKey, systemPath } from '../engines/common.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDir, '..', '..')
const executable = join(
  root,
  'resources',
  'prime-auth',
  'bin',
  executableName('vengeance-prime-auth', hostKey)
)
// Packaging copies the staged helper as-is; a lost executable bit must fail here, not at sign-in.
accessSync(executable, constants.X_OK)
const tempRoot = await mkdtemp(join(tmpdir(), 'vengeance-prime-native-auth-'))
const agentDir = join(tempRoot, 'agent')
const workspaceDir = join(tempRoot, 'workspace')
const requestPaths = []
const apiKey = 'fixture-prime-key'
const tracesKey = 'fixture-traces-key'

await mkdir(agentDir)
await mkdir(workspaceDir)

function answerJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer((request, response) => {
  requestPaths.push(request.url)
  request.resume()

  if (request.url === '/api/v1/auth_challenge/generate') {
    answerJson(response, 503, { message: 'Browser login unavailable in this fixture' })
  } else if (request.url === '/api/v1/user/whoami') {
    const scope =
      request.headers.authorization === `Bearer ${tracesKey}` ? 'agent_traces' : 'inference'
    answerJson(response, 200, { data: { scope: { [scope]: { write: true } } } })
  } else if (request.url === '/api/v1/user/teams?offset=0&limit=100') {
    answerJson(response, 200, {
      data: [{ teamId: 'fixture-team', name: 'Fixture Team', role: 'member' }],
      total_count: 1
    })
  } else {
    answerJson(response, 404, { message: 'Unexpected local fixture request' })
  }
})

let child

async function runPrimeFlow(method, environment, providerId = 'prime-inference', key = apiKey) {
  const firstRequest = requestPaths.length
  child = spawn(executable, [], {
    cwd: workspaceDir,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  const frames = []
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let completed = false
  let secretPrompt = false
  let teamPrompt = false

  const outcome = await new Promise((done, fail) => {
    const fixtureTimeoutMs = 15_000
    const timeout = setTimeout(
      () => fail(new Error('Native Prime fixture timed out')),
      fixtureTimeoutMs
    )

    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (!completed) fail(new Error(`Native helper exited before completion (${code})`))
    })
    child.stdout.on('data', (chunk) => {
      try {
        buffer += decoder.write(chunk)
        let newline

        while ((newline = buffer.indexOf('\n')) !== -1) {
          const frame = JSON.parse(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          frames.push(frame)

          if (frame.type === 'ready') {
            child.stdin.write(
              `${JSON.stringify({
                type: 'start',
                providerId,
                method,
                primeCliConfigPath: null,
                cwd: workspaceDir,
                agentDir
              })}\n`
            )
          } else if (frame.type === 'prompt' && frame.prompt?.type === 'secret') {
            secretPrompt = true
            child.stdin.write(
              `${JSON.stringify({ type: 'reply', promptId: frame.promptId, value: key })}\n`
            )
          } else if (frame.type === 'prompt' && frame.prompt?.type === 'select') {
            teamPrompt = true
            assert.ok(frame.prompt.options.some((option) => option.id === 'team:fixture-team'))
            child.stdin.write(
              `${JSON.stringify({
                type: 'reply',
                promptId: frame.promptId,
                value: 'team:fixture-team'
              })}\n`
            )
          } else if (frame.type === 'done') {
            completed = true
            clearTimeout(timeout)
            done(frame)
          }
        }
      } catch (error) {
        clearTimeout(timeout)
        fail(error)
      }
    })
  })

  return {
    outcome,
    frames,
    secretPrompt,
    teamPrompt,
    paths: requestPaths.slice(firstRequest)
  }
}

function assertSuccessfulTeamSelection(flow, expectedPaths) {
  const { outcome, frames, secretPrompt, teamPrompt, paths } = flow

  assert.equal(outcome.ok, true)
  assert.equal(outcome.credential.type, 'api_key')
  assert.equal(outcome.credential.key, apiKey)
  assert.equal(outcome.credential.primeTeam.teamId, 'fixture-team')
  assert.equal(outcome.credential.primeTeam.name, 'Fixture Team')
  assert.equal(outcome.preservePrimeTeam, false)
  assert.equal(secretPrompt, true)
  assert.equal(teamPrompt, true)
  assert.deepEqual(paths, expectedPaths)
  assert.equal(
    frames.some((frame) => frame.type === 'notice' && frame.notice?.type === 'auth_url'),
    false
  )
  assert.equal(
    frames.some((frame) => frame.type === 'done' && frame.ok !== true),
    false
  )
  assert.equal(
    frames.some((frame) => JSON.stringify(frame).includes(apiKey) && frame.type !== 'done'),
    false
  )
  assert.equal(existsSync(join(agentDir, 'auth.json')), false)
}

function runTraceAction(action, environment, extra = {}) {
  const result = spawnSync(executable, ['--traces'], {
    cwd: workspaceDir,
    env: environment,
    input: JSON.stringify({ action, cwd: workspaceDir, agentDir, ...extra }),
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const frames = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  const final = frames.at(-1)
  assert.equal(final.ok, true, result.stdout)
  return final.result
}

try {
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const fixtureUrl = `http://127.0.0.1:${address.port}`
  const environment = {
    ...process.env,
    ...systemPath(),
    PRIME_AGENT_CODING_AGENT_DIR: agentDir,
    PRIME_AGENT_INFERENCE_API_BASE_URL: fixtureUrl,
    PRIME_AGENT_INFERENCE_FRONTEND_URL: fixtureUrl,
    PRIME_AGENT_TRACES_BASE_URL: fixtureUrl,
    PRIME_AGENT_TRACES_API_KEY: '',
    PRIME_API_KEY: '',
    PRIME_TEAM_ID: '',
    NO_PROXY: '127.0.0.1,localhost'
  }
  const accessAndTeams = ['/api/v1/user/whoami', '/api/v1/user/teams?offset=0&limit=100']

  assertSuccessfulTeamSelection(await runPrimeFlow('oauth', environment), [
    '/api/v1/auth_challenge/generate',
    ...accessAndTeams
  ])
  console.log('Native Prime browser fallback: key access and team selection passed')

  assertSuccessfulTeamSelection(await runPrimeFlow('api_key', environment), accessAndTeams)
  console.log(
    'Native Prime direct API key: access and team selection passed without browser challenge'
  )

  const traceFlow = await runPrimeFlow('api_key', environment, 'prime-agent-traces', tracesKey)
  assert.equal(traceFlow.outcome.ok, true)
  assert.deepEqual(traceFlow.outcome.credential, { type: 'api_key', key: tracesKey })
  assert.equal(traceFlow.secretPrompt, true)
  assert.equal(traceFlow.teamPrompt, false)
  assert.deepEqual(traceFlow.paths, ['/api/v1/user/whoami'])
  assert.equal(
    traceFlow.frames.some(
      (frame) => JSON.stringify(frame).includes(tracesKey) && frame.type !== 'done'
    ),
    false
  )
  assert.equal(existsSync(join(agentDir, 'auth.json')), false)
  console.log('Native Prime traces direct key: agent_traces access passed without browser or team')

  assert.equal(runTraceAction('status', environment).status, 'ready')
  const missingKey = runTraceAction('on', environment)
  assert.equal(missingKey.status, 'missing_credentials')
  assert.equal(missingKey.enabled, false)
  const traceEnvironment = { ...environment, PRIME_AGENT_TRACES_API_KEY: tracesKey }
  const enabled = runTraceAction('on', traceEnvironment)
  assert.equal(enabled.status, 'no_session_file')
  assert.equal(enabled.enabled, true)
  assert.equal(runTraceAction('off', environment).enabled, false)
  assert.equal(runTraceAction('preview', environment).status, 'no_session_file')
  assert.equal(runTraceAction('preview-content', environment).status, 'no_session_file')
  const emptySessionDir = join(tempRoot, 'empty-sessions')
  await mkdir(emptySessionDir)
  const requestsBeforeEmptyUpload = requestPaths.length
  const emptyUpload = runTraceAction('upload-all', traceEnvironment, {
    sessionDir: emptySessionDir
  })
  assert.equal(emptyUpload.total, 0)
  assert.equal(emptyUpload.uploaded, 0)
  assert.equal(requestPaths.length, requestsBeforeEmptyUpload)
  console.log('Native trace settings, missing preview and empty upload-all passed without network')
} finally {
  if (child && child.exitCode === null) child.kill()
  await new Promise((closed) => server.close(closed))

  const resolvedTempRoot = await realpath(tempRoot)
  const resolvedSystemTemp = await realpath(tmpdir())
  assert.ok(resolvedTempRoot.toLowerCase().startsWith(`${resolvedSystemTemp}${sep}`.toLowerCase()))
  await rm(resolvedTempRoot, { recursive: true, force: true })
}
