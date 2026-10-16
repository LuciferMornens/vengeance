import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { reportShotsDir } from '../lib/app.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  assertValidSession,
  SessionBuilder,
  workspaceSessionDir
} from '../sessions/lib/session-files.mjs'

const TOOL_COUNT = 1000
const PINNED_ROW_COUNT = 3
const DETAIL_INDEX = 750
const ERROR_INDICES = new Set([0, 100, 500, TOOL_COUNT - 1])
const MAX_OPEN_MS = 8000
const MAX_SWITCH_MS = 2000
const NAME = 'Grouped tool performance'
const FINAL_TEXT = 'Every grouped tool result is available.'
const REPORT_DIR = reportShotsDir('performance')

async function writeGroupedHistory(agentDir, cwd) {
  const builder = new SessionBuilder({ cwd, stepMs: 1 })
  builder.modelChange()
  builder.user('Inspect every grouped fixture.')
  for (let index = 0; index < TOOL_COUNT; index++) {
    const toolCallId = `grouped-${index}`
    builder.assistant('', {
      toolCalls: [{ id: toolCallId, name: 'read', args: { path: `grouped-${index}.txt` } }]
    })
    builder.add({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId,
        toolName: 'read',
        content: [{ type: 'text', text: `Grouped result ${index}` }],
        isError: ERROR_INDICES.has(index),
        timestamp: builder.clock + builder.stepMs
      }
    })
  }
  builder.assistant(FINAL_TEXT)
  builder.name(NAME)
  const path = await builder.write(workspaceSessionDir(agentDir, cwd))
  await assertValidSession(path)
}

await runSuite(
  'performance-grouped-tools',
  async ({ agentDir, app, step }) => {
    const { agentId: scratchAgent, cwd } = await app.openWorkspace()
    const scratchName = await app.page.getByRole('button', { name: 'Rename session' }).innerText()
    await step('write one assistant turn with a thousand consecutive tool calls', () =>
      writeGroupedHistory(agentDir, cwd)
    )

    const transcript = app.page.locator('[data-transcript-scroll]')
    const group = transcript.locator('[data-activity-group]')
    const header = group.locator('[data-group-header]')
    const rows = group.locator('[data-tool-row]')

    await step('resume the grouped turn with only failed rows pinned', async () => {
      const started = performance.now()
      await app.page.locator('[data-session-row]', { hasText: NAME }).first().click()
      await transcript.getByText(FINAL_TEXT, { exact: true }).waitFor({ timeout: MAX_OPEN_MS })
      await app.page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-activity-group] [data-tool-row]').length === count,
        PINNED_ROW_COUNT
      )
      assert.equal(await group.count(), 1)
      assert.equal(await header.getAttribute('aria-expanded'), 'false')
      assert.equal(await rows.count(), PINNED_ROW_COUNT)
      await group.getByRole('button', { name: '+1 more', exact: true }).waitFor()
      assert.equal(Object.keys((await app.agentState()).tools).length, TOOL_COUNT)
      const elapsed = performance.now() - started
      assert.ok(elapsed < MAX_OPEN_MS, `grouped resume took ${elapsed.toFixed(0)} ms`)
      console.log(`      grouped resume: ${elapsed.toFixed(0)} ms`)
      await app.screenshot('grouped-tools-folded')
    })

    await step('expand the group and inspect a result deep in its history', async () => {
      await group.getByRole('button', { name: '+1 more', exact: true }).click()
      await app.page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-activity-group] [data-tool-row]').length === count,
        TOOL_COUNT
      )
      const detailRow = rows.filter({ hasText: `grouped-${DETAIL_INDEX}.txt` })
      await detailRow.locator('button[aria-expanded]').first().click()
      await detailRow
        .locator('[data-row-detail]')
        .getByText(`Grouped result ${DETAIL_INDEX}`, { exact: true })
        .waitFor()
      await app.screenshot('grouped-tools-detail')
      await header.click()
      await app.page.waitForFunction(
        (count) =>
          document.querySelectorAll('[data-activity-group] [data-tool-row]').length === count,
        PINNED_ROW_COUNT
      )
    })

    await step('switch away and restore the folded group with every result intact', async () => {
      const openRows = app.page.locator('section[aria-label="Open sessions"]')
      await openRows.locator('[data-session-row]', { hasText: scratchName }).first().click()
      await app.page.waitForFunction(
        (expected) => window.__vengeanceTest.activeAgentId() === expected,
        scratchAgent
      )
      const started = performance.now()
      await openRows.locator('[data-session-row]', { hasText: NAME }).first().click()
      await transcript.getByText(FINAL_TEXT, { exact: true }).waitFor()
      const elapsed = performance.now() - started
      assert.ok(elapsed < MAX_SWITCH_MS, `grouped switch took ${elapsed.toFixed(0)} ms`)
      assert.equal(await rows.count(), PINNED_ROW_COUNT)
      const tools = (await app.agentState()).tools
      assert.equal(Object.keys(tools).length, TOOL_COUNT)
      assert.equal(
        tools[`grouped-${DETAIL_INDEX}`].result.content[0].text,
        `Grouped result ${DETAIL_INDEX}`
      )
      console.log(`      grouped cached switch: ${elapsed.toFixed(0)} ms`)
    })
  },
  { launch: { outDir: REPORT_DIR } }
)
