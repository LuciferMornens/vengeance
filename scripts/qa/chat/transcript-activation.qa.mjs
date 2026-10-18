import assert from 'node:assert/strict'
import { runSuite } from '../lib/suite.mjs'
import { SessionBuilder, workspaceSessionDir } from '../sessions/lib/session-files.mjs'
import { sleep, until } from './helpers.mjs'

const EARLIER_TURNS = 20
const RECENT_TURNS = 38
const PARAGRAPHS_PER_TURN = 32
const HISTORY_NAME = 'Scroll: compaction threshold'
const MIDPOINT_TURN = Math.floor(RECENT_TURNS / 2)
const POSITION_TOLERANCE_PX = 12
const STABILITY_MS = 1000
const ESTIMATED_SEGMENT_HEIGHT = 180

function tallAnswer(group, index) {
  return [
    `## ${group} answer ${index}`,
    ...Array.from(
      { length: PARAGRAPHS_PER_TURN },
      (_, paragraph) =>
        `Paragraph ${paragraph} explains the request handling in ${group} area ${index}.`
    )
  ].join('\n\n')
}

await runSuite('chat-transcript-activation', async ({ app, agentDir, step }) => {
  const { cwd } = await app.openWorkspace()
  const session = new SessionBuilder({ cwd })
  session.modelChange()
  for (let index = 0; index < EARLIER_TURNS; index++) {
    session.user(`Earlier question ${index}`)
    session.assistant(tallAnswer('Earlier', index))
  }
  let firstKept
  for (let index = 0; index < RECENT_TURNS; index++) {
    const entry = session.user(`Recent question ${index}`)
    firstKept ??= entry.id
    session.assistant(tallAnswer('Recent', index))
  }
  session.compaction('The earlier requests were summarized.', firstKept)
  session.name(HISTORY_NAME)
  const path = await session.write(workspaceSessionDir(agentDir, cwd))
  const scroller = app.page.locator('[data-transcript-scroll]')
  const heading = scroller.getByRole('heading', {
    name: `Recent answer ${MIDPOINT_TURN}`,
    exact: true
  })

  await step('open a short visible context with tall rows', async () => {
    await app.test('openSession', path, 'pi')
    await scroller.getByRole('heading', { name: `Recent answer ${RECENT_TURNS - 1}` }).waitFor()
    assert.equal(await app.page.locator('[data-virtual-segments]').count(), 0)
    await until(
      () =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 1
        ),
      { label: 'the visible context opens at its latest answer' }
    )
  })

  await step('pause at a tall midpoint before loading earlier history', async () => {
    await scroller.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
    })
    for (let index = 0; index <= MIDPOINT_TURN; index++) {
      await scroller
        .getByRole('heading', { name: `Recent answer ${index}`, exact: true })
        .scrollIntoViewIfNeeded()
    }
    await sleep(STABILITY_MS)
    await app.page.getByRole('button', { name: 'Jump to latest' }).waitFor()
    const top = await scroller.evaluate((element) => element.scrollTop)
    assert.ok(
      top > (EARLIER_TURNS + RECENT_TURNS) * 2 * ESTIMATED_SEGMENT_HEIGHT,
      `the tall midpoint offset ${top}px exceeds the estimated virtual list`
    )
  })

  await step('cross the virtualization threshold without moving the paused reader', async () => {
    const before = await heading.boundingBox()
    await scroller
      .getByRole('button', { name: 'Show earlier messages' })
      .evaluate((button) => button.click())
    await app.page.locator('[data-virtual-segments]').waitFor()
    await sleep(STABILITY_MS)
    const after = await heading.boundingBox({ timeout: STABILITY_MS })
    assert.ok(after, 'the midpoint remains mounted')
    assert.ok(
      Math.abs(after.y - before.y) <= POSITION_TOLERANCE_PX,
      `the paused midpoint moved ${after.y - before.y}px`
    )
    await app.page.getByRole('button', { name: 'Jump to latest' }).waitFor()
    await app.screenshot('threshold-paused-midpoint')
  })

  await step('Jump to latest follows after the threshold transition', async () => {
    await app.page.getByRole('button', { name: 'Jump to latest' }).click()
    await until(
      () =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 1
        ),
      { label: 'the virtualized history reaches its latest answer' }
    )
    await sleep(STABILITY_MS)
    assert.equal(await app.page.getByRole('button', { name: 'Jump to latest' }).count(), 0)
    await app.screenshot('threshold-latest')
  })
})
