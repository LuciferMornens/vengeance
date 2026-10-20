import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { check } from './harness'

/** The isolation functions of scripts/shots.mjs, which launches nothing when imported. */
interface ShotsHarness {
  appEnv(base: Record<string, string>, userData: string): Record<string, string>
  engineDirProblems(env: Record<string, string | undefined>, appTemp: string): string[]
}

// A non-literal specifier keeps esbuild from bundling the harness and Playwright into the checks.
const harnessUrl = pathToFileURL(join(process.cwd(), 'scripts', 'shots.mjs')).href
const shots = (await import(harnessUrl)) as ShotsHarness

await check('shots: the app inherits no Engine or Engine 2 variable from the harness', () => {
  const env = shots.appEnv(
    {
      PATH: 'p',
      PI_CODING_AGENT_DIR: 'real-agent-dir',
      pi_offline: '1',
      PRIME_AGENT_CODING_AGENT_DIR: 'real-prime-dir',
      AI_AGENT: 'pi',
      AI_AGENTS: 'keep'
    },
    'user-data'
  )
  assert.deepEqual(env, {
    PATH: 'p',
    AI_AGENTS: 'keep',
    VENGEANCE_MOCK: '1',
    VENGEANCE_TEST: '1',
    VENGEANCE_NO_MICA: '1',
    VENGEANCE_USER_DATA: 'user-data'
  })
})

await check('shots: a scenario runs only with Engine folders inside its own temp root', () => {
  const temp = join(tmpdir(), 'vengeance-shots-x', 'tmp')
  const agentDir = join(temp, 'vengeance-mock-engine-a', 'agent')
  assert.deepEqual(shots.engineDirProblems({ PI_CODING_AGENT_DIR: agentDir }, temp), [])
  assert.equal(shots.engineDirProblems({}, temp).length, 1, 'the mock agent dir is required')
  assert.equal(
    shots.engineDirProblems({ PI_CODING_AGENT_DIR: join(tmpdir(), 'elsewhere', 'agent') }, temp)
      .length,
    1,
    'an Engine agent dir outside the temp root'
  )
  assert.equal(
    shots.engineDirProblems(
      {
        PI_CODING_AGENT_DIR: agentDir,
        PRIME_AGENT_CODING_AGENT_DIR: join(temp, '..', '..', 'prime')
      },
      temp
    ).length,
    1,
    'an Engine 2 agent dir that climbs out of the temp root'
  )
})
