// The harness itself: fake mode never loads the user's own resources (~/.agents/skills), a plain
// workspace opens without a Trust dialog, and openWorkspace/send/waitForSettle drive the ACTIVE
// session when several are open (each switch plays a pane fade-out).
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { REAL_HOME } from '../lib/tmp.mjs'

/** Skill names in the user's real ~/.agents/skills (names only; nothing is read from them). */
async function realUserSkillNames() {
  const entries = await readdir(join(REAL_HOME, '.agents', 'skills'), {
    withFileTypes: true
  }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

await runSuite('shell-harness-isolation', async ({ server, app, step }) => {
  let first
  await step('a plain workspace opens straight into a session (no Trust dialog)', async () => {
    first = await app.openWorkspace()
    assert.equal(await app.page.getByRole('dialog', { name: /^Trust/ }).count(), 0)
  })

  await step("the engine's commands contain none of the user's ~/.agents skills", async () => {
    const userSkills = await realUserSkillNames()
    const { commands } = await app.rpc({ type: 'get_commands' })
    const names = commands.map((command) => command.name)
    const leaked = userSkills.filter((skill) => names.includes(`skill:${skill}`))
    assert.deepEqual(leaked, [], `user skills in fake mode: ${leaked.join(', ')}`)
  })

  await step('a second session: send and settle target the active pane', async () => {
    const second = await app.openWorkspace()
    assert.notEqual(second.agentId, first.agentId)
    server.queue(turn.text('Second session answers.'))
    await app.send('hello from the second session')
    await app.waitForSettle()
    await app.page.getByText('Second session answers.').waitFor()
    assert.equal((await app.agentState(first.agentId)).entries.length, 0)
  })

  await step('a third session in the first workspace: send reaches it', async () => {
    const third = await app.openWorkspace({ cwd: first.cwd })
    assert.equal(await app.activeAgentId(), third.agentId)
    server.queue(turn.text('Third session answers.'))
    await app.send('hello again')
    await app.waitForSettle()
    await app.page.getByText('Third session answers.').waitFor()
  })
})
