import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setProjectTrust, setTrustEntry, trustPreflight } from '../../src/main/features/launch/trust'
import { check } from './harness'

/**
 * N9: the single trust-write path, against the INSTALLED engine's ProjectTrustStore with a temp
 * PI_CODING_AGENT_DIR (never the user's real ~/.pi/agent). Skipped when no engine is installed.
 */

function trustFile(agentDir: string): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(join(agentDir, 'trust.json'), 'utf8')) as Record<string, boolean>
  } catch {
    return {}
  }
}

const previous = process.env.PI_CODING_AGENT_DIR
const root = mkdtempSync(join(tmpdir(), 'vengeance-trust-check-'))
const agentDir = join(root, 'agent')
const parent = join(root, 'work')
const child = join(parent, 'app')
mkdirSync(agentDir, { recursive: true })
mkdirSync(join(child, '.pi'), { recursive: true })
process.env.PI_CODING_AGENT_DIR = agentDir

let engine = true
try {
  await trustPreflight(null, child)
} catch (error) {
  engine = false
  console.warn(`  ⚠ installed engine not available, skipped trust checks: ${(error as Error).message}`)
}

try {
  if (engine) {
    await check('setProjectTrust (N9): true/false save the folder itself; children inherit', async () => {
      const saved = await setProjectTrust(null, parent, true)
      assert.equal(saved.saved, true)
      assert.equal(Object.values(trustFile(agentDir)).length, 1)
      const inherited = await trustPreflight(null, child)
      assert.equal(inherited.saved, true)
      assert.equal(inherited.engineDefault, true)
      await setProjectTrust(null, child, false)
      assert.equal(Object.values(trustFile(agentDir)).length, 2)
      assert.equal((await trustPreflight(null, child)).saved, false)
      assert.equal((await trustPreflight(null, parent)).saved, true)
    })

    await check('setProjectTrust (N9): null forgets the decision that applies, even a parent one', async () => {
      await setProjectTrust(null, child, null)
      assert.equal((await trustPreflight(null, child)).saved, true, 'child falls back to the parent decision')
      const forgotten = await setProjectTrust(null, child, null)
      assert.equal(forgotten.saved, null)
      assert.deepEqual(trustFile(agentDir), {})
    })

    await check('setTrustEntry: edits one saved entry by its exact folder', async () => {
      await setProjectTrust(null, parent, true)
      const [key] = Object.keys(trustFile(agentDir))
      await setTrustEntry(null, key!, false)
      assert.equal((await trustPreflight(null, child)).saved, false)
      await setTrustEntry(null, key!, null)
      assert.deepEqual(trustFile(agentDir), {})
    })
  }
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previous
  rmSync(root, { recursive: true, force: true })
}
