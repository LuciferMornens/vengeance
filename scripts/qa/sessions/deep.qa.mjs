// Deep sessions: a 3000+ entry linear session file (deeper than the Engine's recursive get_tree serializer
// manages) in the temp sessions folder. It must list, resume, render its transcript and its tree (open and
// closed), list its fork points, and take a new prompt with the whole history as context.
//
//   node scripts/qa/sessions/deep.qa.mjs
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  createChecks,
  openBranchesTab,
  sendWhenSettled,
  SHOTS_DIR,
  waitUntil
} from './lib/checks.mjs'
import { assertValidSession, SessionBuilder, workspaceSessionDir } from './lib/session-files.mjs'

const TURNS = 1600
const NAME = 'Deep fuzzing marathon'

await runSuite(
  'sessions-deep',
  async ({ server, agentDir, app, step }) => {
    const { check, finish } = createChecks(step, () => app, 'deep')
    const page = app.page
    const { agentId: scratchAgent, cwd } = await step('open a workspace', () => app.openWorkspace())

    const file = await step(`write a ${TURNS * 2 + 2}-entry session file`, async () => {
      const builder = new SessionBuilder({ cwd, startedAt: Date.now() - 2 * 3_600_000, stepMs: 2 })
      builder.modelChange()
      for (let i = 1; i <= TURNS; i++) {
        builder.user(`deep question ${i}`)
        builder.assistant(`deep answer ${i}`)
      }
      builder.name(NAME)
      const path = await builder.write(workspaceSessionDir(agentDir, cwd))
      const session = await assertValidSession(path)
      assert.ok(session.entries.length >= 3000)
      return path
    })

    const row = page.locator('[data-session-row]', { hasText: NAME }).first()

    await check('the deep session is listed with its message count', async () => {
      await row.waitFor({ timeout: 15_000 })
      assert.match(await row.innerText(), /3,200 messages|3200 messages/)
    })

    await check(
      'closed-session tree dialog renders the deep tree (windowed, "Show earlier")',
      async () => {
        await row.click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Browse session tree…' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByText(`deep answer ${TURNS}`).waitFor({ timeout: 30_000 })
        const earlier = dialog.getByRole('button', { name: /^Show \d+ earlier$/ })
        await earlier.waitFor()
        const nodes = await dialog.locator('[data-tree-node]').count()
        assert.ok(nodes <= 100, `windowed: ${nodes} nodes mounted`)
        await earlier.click()
        await waitUntil(async () => (await dialog.locator('[data-tree-node]').count()) > nodes, {
          label: 'more nodes'
        })
        await app.screenshot('deep-closed-tree', { settleMs: 300 })
        await page.keyboard.press('Escape')
      }
    )

    let deepAgent
    await check('opening it resumes the engine and renders the latest turns', async () => {
      const started = performance.now()
      await row.click()
      await page
        .locator('[data-session-pane]')
        .getByText(`deep answer ${TURNS}`, { exact: true })
        .waitFor({ timeout: 60_000 })
      const seconds = (performance.now() - started) / 1000
      deepAgent = await app.activeAgentId()
      assert.notEqual(deepAgent, scratchAgent)
      const state = await app.rpc({ type: 'get_state' })
      assert.equal(state.sessionFile.toLowerCase(), file.toLowerCase())
      assert.equal(state.sessionName, NAME)
      console.log(`      resumed and rendered in ${seconds.toFixed(1)}s`)
      assert.ok(seconds < 20, `resume took ${seconds.toFixed(1)}s`)
      await app.screenshot('deep-transcript', { settleMs: 300 })
    })

    await check(
      'the Branches tab renders the deep tree (get_tree falls back to get_entries)',
      async () => {
        await openBranchesTab(app)
        const panel = page.locator('[data-tree-node]', { hasText: `deep answer ${TURNS}` })
        await panel.waitFor({ timeout: 30_000 })
        assert.match(await panel.innerText(), /You are here/)
        await page.getByRole('button', { name: /^Show \d+ earlier$/ }).waitFor()
        assert.equal(await page.getByText('Could not load the session tree').count(), 0)
        await app.screenshot('deep-branches', { settleMs: 300 })
      }
    )

    await check(
      'the Branches tab shows the current position ("You are here") without scrolling',
      async () => {
        const leaf = page.locator('[data-tree-node]', { hasText: `deep answer ${TURNS}` })
        const box = await leaf.boundingBox()
        const viewport = { height: await page.evaluate(() => window.innerHeight) }
        assert.ok(
          box && box.y >= 0 && box.y + box.height <= viewport.height,
          `leaf node at y=${box?.y} in a ${viewport.height}px window`
        )
      }
    )

    await check('the fork dialog lists every user message with a filter', async () => {
      await page.getByRole('button', { name: 'Fork from a message…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByPlaceholder('Filter messages…').waitFor({ timeout: 30_000 })
      await dialog.getByPlaceholder('Filter messages…').fill('deep question 1234')
      await dialog.getByText('deep question 1234', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
    })

    await check('a new prompt carries the whole deep history as context', async () => {
      const from = server.requests.length
      server.queue(turn.text('Deep reply after resume.'))
      await sendWhenSettled(app, 'one more deep question')
      await app.waitForSettle({ timeoutMs: 120_000 })
      const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
      assert.equal(sent.lastUserText, 'one more deep question')
      assert.ok(sent.messages.length >= TURNS * 2, `${sent.messages.length} messages in context`)
      assert.equal(sent.messages[0].text, 'deep question 1')
      await assertValidSession(file)
      assert.ok(deepAgent)
    })

    finish()
  },
  { launch: { outDir: SHOTS_DIR } }
)
