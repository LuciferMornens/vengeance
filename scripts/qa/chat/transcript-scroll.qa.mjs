// Chat: the transcript follows the bottom until the user scrolls away. Opening and restoring a long (virtualized)
// session lands on the latest message; wheel, scrollbar drag and scroll keys stop following while text keeps
// streaming, keys typed in the composer do not; "Jump to latest" follows again; a click that expands the last row
// follows it at once; a short scroll up shows the pill once the answer has grown past it; a scroll with no input
// event (a screen reader) leaves the bottom; going back to an earlier point from the session tree shows that point
// and stays there.
//
//   node scripts/qa/chat/transcript-scroll.qa.mjs
import assert from 'node:assert/strict'
import { longSession } from '../../perf/lib/fixtures.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { openBranchesTab } from '../sessions/lib/checks.mjs'
import { messageText, workspaceSessionDir } from '../sessions/lib/session-files.mjs'
import { sleep, until } from './helpers.mjs'

const LONG_SESSION_NAME = 'Scroll: long working session'
const LONG_SESSION_LAST_TEXT = 'Step 59: what changed'
/** Within this distance (px) of the bottom the transcript counts as following it (Transcript.tsx re-pins under 12). */
const AT_BOTTOM_PX = 12
/** The "Jump to latest" pill shows beyond this distance (Transcript.tsx). */
const DETACHED_PX = 80
/** How long a position must hold to count as settled or stable. */
const HOLD_MS = 1000
const STREAM_LINES = 400
const STREAM_CHUNK_CHARS = 24
const STREAM_DELAY_MS = 12
/** Bash output long enough that expanding its row grows the transcript well past the bottom. */
const LISTING_COMMAND = 'for i in $(seq 1 40); do echo "listing line $i"; done'
/** After a row has stopped growing, following must catch up within this long (a frame or two, not an intent window). */
const FOLLOW_LAG_MS = 150
/** A slow answer, one paragraph per delta: scrolls can land between growths. */
const SLOW_PARAGRAPHS = 40
const SLOW_DELAY_MS = 300
/** A short wheel up ends inside the pill's distance. */
const SHORT_WHEEL_PX = 40
/** A scroll with no input event (a screen reader), well off the bottom. */
const SILENT_SCROLL_PX = 300

function streamedAnswer() {
  return Array.from(
    { length: STREAM_LINES },
    (_, line) => `Line ${line + 1} of the streamed answer keeps the transcript growing for a while.`
  ).join('\n\n')
}

const slowParagraph = (index) =>
  `Slow paragraph ${String(index + 1).padStart(2, '0')} arrives on its own.\n\n`
const slowAnswer = () =>
  Array.from({ length: SLOW_PARAGRAPHS }, (_, index) => slowParagraph(index)).join('')

await runSuite('chat-transcript-scroll', async ({ server, agentDir, app: firstApp, step }) => {
  let app = firstApp
  const scroller = () => app.page.locator('[data-session-pane] [data-transcript-scroll]')
  const jumpPill = () => app.page.getByRole('button', { name: 'Jump to latest' })
  const geometry = () =>
    scroller().evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
      distance: el.scrollHeight - el.scrollTop - el.clientHeight
    }))

  /**
   * Distance from the bottom as the next frame paints. A read between a render's commit and the next frame sees
   * growth that the frame's follow corrects before it paints; an off-bottom read is confirmed on the next frame.
   */
  async function paintedDistance() {
    const { distance } = await geometry()
    if (distance < AT_BOTTOM_PX) return distance
    return scroller().evaluate(
      (el) =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            setTimeout(() => resolve(el.scrollHeight - el.scrollTop - el.clientHeight), 0)
          )
        )
    )
  }

  /** The view stays at the bottom for HOLD_MS (rows measuring and content growing included). */
  async function assertFollowsBottom(label) {
    await until(async () => (await geometry()).distance < AT_BOTTOM_PX, {
      label: `${label}: at the bottom`
    })
    const deadline = Date.now() + HOLD_MS
    while (Date.now() < deadline) {
      const distance = await paintedDistance()
      assert.ok(distance < AT_BOTTOM_PX, `${label}: left the bottom (${Math.round(distance)} px)`)
      await sleep(50)
    }
    assert.equal(await jumpPill().count(), 0, `${label}: no Jump to latest pill`)
  }

  /** The view stays where the user left it while the streamed answer keeps growing below. */
  async function assertStaysPut(label) {
    await jumpPill().waitFor()
    // A smooth key or wheel scroll runs on for a moment.
    let previous = await geometry()
    await until(
      async () => {
        await sleep(150)
        const current = await geometry()
        const settled = current.top === previous.top
        previous = current
        return settled
      },
      { label: `${label}: the scroll came to rest` }
    )
    const before = await geometry()
    assert.ok(before.distance > DETACHED_PX, `${label}: left the bottom`)
    await sleep(HOLD_MS)
    const after = await geometry()
    assert.ok(after.height > before.height, `${label}: the answer kept streaming`)
    assert.ok(Math.abs(after.top - before.top) <= 2, `${label}: moved ${after.top - before.top} px`)
  }

  async function wheelUp() {
    const box = await scroller().boundingBox()
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await app.page.mouse.wheel(0, -600)
    await until(async () => (await geometry()).distance > DETACHED_PX, {
      label: 'wheel scrolled up'
    })
  }

  /** Resolves once the transcript grew: the next growth is a slow answer's delta away. */
  async function afterGrowth() {
    const { height } = await geometry()
    await until(async () => (await geometry()).height > height, { label: 'the answer grew' })
  }

  async function jumpToLatest(label) {
    await jumpPill().click()
    await assertFollowsBottom(label)
    const { height } = await geometry()
    await until(async () => (await geometry()).height > height, { label: `${label}: more text` })
    assert.ok((await paintedDistance()) < AT_BOTTOM_PX, `${label}: follows the stream`)
  }

  const { cwd } = await step('open a workspace with a long saved session', async () => {
    const opened = await app.openWorkspace()
    await longSession(opened.cwd, { name: LONG_SESSION_NAME }).write(
      workspaceSessionDir(agentDir, opened.cwd)
    )
    return opened
  })

  await step('opening the long session lands on its latest message', async () => {
    await app.page.locator('[data-session-row]', { hasText: LONG_SESSION_NAME }).first().click()
    await scroller().getByText(LONG_SESSION_LAST_TEXT).waitFor()
    assert.ok(
      (await app.page.locator('[data-virtual-segments]').count()) === 1,
      'the long session renders virtualized'
    )
    await assertFollowsBottom('opened')
  })

  try {
    await step('restoring the long session at launch lands on its latest message', async () => {
      app = await app.relaunch()
      await scroller().getByText(LONG_SESSION_LAST_TEXT).waitFor({ timeout: 30_000 })
      await assertFollowsBottom('restored')
    })

    await step('stream a long answer in a new session, following the bottom', async () => {
      await app.openWorkspace({ cwd })
      server.queue(turn.text('The first answer, before the long one.'))
      await app.send('First question')
      await app.waitForSettle()
      server.queue(
        turn.text(streamedAnswer(), { chunkSize: STREAM_CHUNK_CHARS, delayMs: STREAM_DELAY_MS })
      )
      await app.send('Write a long answer')
      await until(
        async () => {
          const { height } = await geometry()
          return height > 3 * (await scroller().evaluate((el) => el.clientHeight))
        },
        { label: 'a long streamed answer' }
      )
      await assertFollowsBottom('streaming')
    })

    await step('wheel up while streaming stops following', async () => {
      await wheelUp()
      await assertStaysPut('wheel')
    })

    await step('Jump to latest follows the stream again', () => jumpToLatest('jump after wheel'))

    // Inside the wheel's scroll-intent window: the glide down must not read as the user leaving.
    await step('Jump to latest right after a wheel still follows', async () => {
      await wheelUp()
      await jumpToLatest('jump right after wheel')
    })

    await step('scroll keys typed in the composer keep following', async () => {
      await (await app.composer()).click()
      await app.page.keyboard.press('PageUp')
      await app.page.keyboard.press('Home')
      await assertFollowsBottom('composer keys')
    })

    await step('scroll keys in the transcript stop following', async () => {
      const box = await scroller().boundingBox()
      await app.page.mouse.click(box.x + box.width / 2, box.y + box.height / 3)
      await app.page.keyboard.press('PageUp')
      await until(async () => (await geometry()).distance > DETACHED_PX, {
        label: 'PageUp scrolled up'
      })
      await assertStaysPut('PageUp')
    })

    await step('Jump to latest after scroll keys', () => jumpToLatest('jump after keys'))

    await step('dragging the scrollbar up stops following', async () => {
      const box = await scroller().boundingBox()
      const { thumbTop, thumbHeight } = await scroller().evaluate((el) => ({
        thumbTop: (el.scrollTop / el.scrollHeight) * el.clientHeight,
        thumbHeight: (el.clientHeight / el.scrollHeight) * el.clientHeight
      }))
      const x = box.x + box.width - 5
      const y = box.y + thumbTop + thumbHeight / 2
      await app.page.mouse.move(x, y)
      await app.page.mouse.down()
      await app.page.mouse.move(x, y - 120, { steps: 6 })
      await app.page.mouse.up()
      await until(async () => (await geometry()).distance > DETACHED_PX, {
        label: 'the scrollbar drag scrolled up'
      })
      await assertStaysPut('scrollbar drag')
      await app.waitForSettle()
    })

    // The click focuses the toggle (a scroll-intent window) and the row grows inside that window, then stops.
    await step('expanding the last tool row at the bottom keeps following', async () => {
      // Back from the scrollbar drag above.
      await jumpPill().click()
      await assertFollowsBottom('before the tool turn')
      server.queue(
        turn.toolCalls([
          { id: 'qa-scroll-bash', name: 'bash', args: { command: LISTING_COMMAND } }
        ]),
        turn.text('The listing is above.')
      )
      await app.send('List some lines')
      await app.waitForSettle()
      await assertFollowsBottom('after the tool turn')
      const toggles = scroller().locator('button[aria-expanded]')
      // Uncovered and in view: a click on a toggle above the view would scroll up to it first (leaving the
      // bottom), and the composer floats over the transcript's last pixels.
      const last = await toggles.evaluateAll((buttons) =>
        buttons.findLastIndex((button) => {
          const rect = button.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return button.getAttribute('aria-expanded') === 'false' && !!hit && button.contains(hit)
        })
      )
      assert.ok(last >= 0, 'a collapsed row in view')
      const toggle = toggles.nth(last)
      const before = await geometry()
      // Every frame for a while: when the height last changed, and when the view was back on the bottom.
      const frames = scroller().evaluate(
        (el, durationMs) =>
          new Promise((resolve) => {
            const started = performance.now()
            const samples = []
            const tick = () => {
              const at = performance.now() - started
              samples.push({
                at,
                height: el.scrollHeight,
                distance: el.scrollHeight - el.scrollTop - el.clientHeight
              })
              if (at > durationMs) resolve(samples)
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          }),
        1500
      )
      await toggle.click()
      const samples = await frames
      const grownAt = samples.findLastIndex(
        (sample, index) => index > 0 && sample.height !== samples[index - 1].height
      )
      assert.ok(grownAt > 0, 'the row grew while sampled')
      const caughtUp = samples.slice(grownAt).find((sample) => sample.distance < AT_BOTTOM_PX)
      assert.ok(caughtUp, 'the view came back to the bottom')
      const lag = caughtUp.at - samples[grownAt].at
      assert.ok(lag <= FOLLOW_LAG_MS, `followed the expansion ${Math.round(lag)} ms late`)
      // The row opens with an animation: wait until it has grown and settled.
      let previous = before
      await until(
        async () => {
          await sleep(150)
          const current = await geometry()
          const settled = current.height > before.height && current.height === previous.height
          previous = current
          return settled
        },
        { label: 'the row expanded' }
      )
      await assertFollowsBottom('expanded row')
    })

    await step('a short scroll up while streaming shows Jump to latest as the answer grows', async () => {
      server.queue(
        turn.text(slowAnswer(), { chunkSize: slowParagraph(0).length, delayMs: SLOW_DELAY_MS })
      )
      await app.send('Write a slow answer')
      await scroller().getByText('Slow paragraph 02').waitFor()
      await assertFollowsBottom('slow answer')
      await afterGrowth()
      const box = await scroller().boundingBox()
      await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await app.page.mouse.wheel(0, -SHORT_WHEEL_PX)
      await jumpPill().waitFor({ timeout: 5 * SLOW_DELAY_MS + 1000 })
      await jumpToLatest('jump after a short wheel')
    })

    await step('a scroll with no input event (a screen reader) leaves the bottom', async () => {
      await afterGrowth()
      const top = await scroller().evaluate((el, px) => {
        el.scrollTop -= px
        return el.scrollTop
      }, SILENT_SCROLL_PX)
      await afterGrowth()
      await afterGrowth()
      const after = await geometry()
      assert.ok(Math.abs(after.top - top) <= 2, `moved ${after.top - top} px`)
      await jumpPill().waitFor({ timeout: 2000 })
      await jumpToLatest('jump after a silent scroll')
      await app.waitForSettle()
    })

    await step(
      'going back to an earlier point from the tree shows it and stays there',
      async () => {
        const { entries } = await app.rpc({ type: 'get_entries' })
        const firstAnswer = entries.find(
          (entry) =>
            entry.type === 'message' &&
            messageText(entry.message) === 'The first answer, before the long one.'
        )
        await openBranchesTab(app)
        const node = app.page.locator(`[data-tree-node="${firstAnswer.id}"]`)
        const button = node.locator('> button')
        if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
        await node.getByRole('button', { name: 'Go to this point' }).click()
        const dialog = app.page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'Go to this point' }).click()
        await until(
          async () => (await scroller().getByText('Line 1 of the streamed answer').count()) === 0,
          { label: 'transcript rewound to the first answer' }
        )
        await assertFollowsBottom('tree')
        const answer = await scroller()
          .getByText('The first answer, before the long one.')
          .boundingBox()
        const view = await scroller().boundingBox()
        assert.ok(
          answer && answer.y >= view.y && answer.y + answer.height <= view.y + view.height,
          'the earlier point is in view'
        )
      }
    )
  } finally {
    if (app !== firstApp) await app.close()
  }
})
