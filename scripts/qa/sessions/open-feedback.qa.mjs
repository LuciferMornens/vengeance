import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { longSession } from '../../perf/lib/fixtures.mjs'
import { reportShotsDir } from '../lib/app.mjs'
import { runSuite } from '../lib/suite.mjs'
import { makePng, sleep, until } from '../chat/helpers.mjs'
import { closeSettings, openSettings } from '../settings/settings-ui.mjs'
import { SessionBuilder, workspaceSessionDir } from './lib/session-files.mjs'

const MAX_ACKNOWLEDGMENT_MS = 150
const DOUBLE_CLICK_WINDOW_MS = 250
const CANCELED_OPEN_WAIT_MS = 400
const CLICK_PROBE_TIMEOUT_MS = 5000
const IMAGE_SIZE = 24
const IMAGE_COLOR = [40, 120, 220]
const IMAGE_BASE64 = makePng(IMAGE_SIZE, IMAGE_SIZE, IMAGE_COLOR).toString('base64')
const OUTPUT_DIRECTORY = reportShotsDir('open-feedback')
const BASELINE_TITLE = 'Feedback baseline'
const SHADOW_COMMAND_NOTICE = 'QA native new command ran'
const SHADOW_COMMAND_EXTENSION = `
export default function (engine) {
  engine.registerCommand('new', {
    description: 'Verify native command precedence during history readiness',
    handler: (_arguments, context) => context.ui.notify('${SHADOW_COMMAND_NOTICE}', 'info')
  })
}
`
const TITLES = [
  'Mouse open',
  'Keyboard open',
  'Canceled timer',
  'Mouse replacement',
  'F2 rename',
  'Keep focus during delay',
  'Keep focus before create',
  'Focus after refresh',
  'Ready before commands',
  'Empty ready before commands',
  'Joined history',
  'Commands unavailable',
  'Keep sidebar focus',
  'Keep settings focus',
  'Older request',
  'Newer request',
  'Failed open'
]

async function installDelays(application) {
  await application.evaluate(({ ipcMain }) => {
    const handlers = new Map()
    const gates = new Map()
    const paths = new Map()
    for (const channel of ['engine:create', 'sessions:describe', 'engine:command']) {
      const original = ipcMain._invokeHandlers.get(channel)
      handlers.set(channel, original)
      // Delay only the IPC boundary; every released request still executes the real handler.
      ipcMain._invokeHandlers.set(channel, async (...parameters) => {
        let path = parameters[1]
        let operation = channel
        if (channel === 'engine:create') {
          path = parameters[1].sessionPath
          paths.set(parameters[2], path)
        } else if (channel === 'engine:command') {
          path = paths.get(parameters[1])
          operation = `${channel}:${parameters[2].type}`
        }
        const gate = gates.get(`${operation}:${path}`)
        if (gate) {
          gate.entered = true
          await gate.wait
          if (gate.error) throw new Error(gate.error)
        }
        return original(...parameters)
      })
    }
    globalThis.__openFeedbackGates = gates
    globalThis.__restoreOpenFeedback = () => {
      for (const gate of gates.values()) gate.release()
      for (const [channel, handler] of handlers) ipcMain._invokeHandlers.set(channel, handler)
      delete globalThis.__openFeedbackGates
      delete globalThis.__restoreOpenFeedback
    }
  })
}

async function hold(application, path, channel = 'engine:create') {
  await application.evaluate((_, key) => {
    let release
    const wait = new Promise((complete) => {
      release = complete
    })
    globalThis.__openFeedbackGates.set(key, { wait, release, entered: false })
  }, `${channel}:${path}`)
}

async function entered(application, path, channel = 'engine:create') {
  await until(
    () =>
      application.evaluate(
        (_, key) => globalThis.__openFeedbackGates.get(key)?.entered,
        `${channel}:${path}`
      ),
    { label: 'the public open reaches its held IPC boundary' }
  )
}

async function release(application, path, channel = 'engine:create') {
  await application.evaluate((_, key) => {
    globalThis.__openFeedbackGates.get(key).release()
  }, `${channel}:${path}`)
}

async function rejectCatalog(application, path) {
  await application.evaluate((_, key) => {
    const gate = globalThis.__openFeedbackGates.get(key)
    gate.error = 'QA command catalog unavailable'
    gate.release()
  }, `engine:command:get_commands:${path}`)
}

async function clickTiming(row, deferred, activate) {
  const element = await row.elementHandle()
  assert.ok(element, 'the row is mounted before arming its timing probe')
  try {
    await element.evaluate(
      (target, { waitsForRename, timeoutMs }) => {
        let frame
        let timeout
        let complete
        let finished = false
        const result = new Promise((resolveMeasurement) => {
          complete = resolveMeasurement
        })
        const finish = (measurement) => {
          if (finished) return
          finished = true
          clearTimeout(timeout)
          cancelAnimationFrame(frame)
          target.removeEventListener('click', clicked, true)
          complete(measurement)
        }
        const clicked = () => {
          const started = performance.now()
          let acknowledged
          const sample = () => {
            const now = performance.now()
            if (acknowledged === undefined && target.getAttribute('aria-busy') === 'true') {
              acknowledged = now - started
            }
            if (document.querySelector('[data-session-opening]')) {
              finish({
                acknowledgmentMs: waitsForRename ? acknowledged : now - started,
                openingMs: now - started
              })
            } else frame = requestAnimationFrame(sample)
          }
          frame = requestAnimationFrame(sample)
        }
        target.addEventListener('click', clicked, { capture: true, once: true })
        timeout = setTimeout(
          () => finish({ error: 'Opening feedback was not observed' }),
          timeoutMs
        )
        target.__qaOpenFeedbackTiming = { result, cancel: () => finish({ error: 'Canceled' }) }
      },
      { waitsForRename: deferred, timeoutMs: CLICK_PROBE_TIMEOUT_MS }
    )
    await activate()
    const measurement = await element.evaluate((target) => target.__qaOpenFeedbackTiming.result)
    assert.equal(measurement.error, undefined, JSON.stringify(measurement))
    return measurement
  } finally {
    await element
      .evaluate(async (target) => {
        const probe = target.__qaOpenFeedbackTiming
        if (!probe) return
        probe.cancel()
        await probe.result
        delete target.__qaOpenFeedbackTiming
      })
      .catch(() => undefined)
    await element.dispose()
  }
}

async function dropImage(app, target, name) {
  return app.page.evaluate(
    ({ selector, imageName, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], imageName, { type: 'image/png' }))
      const element = document.querySelector(selector)
      const prevented = {}
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true
        })
        element.dispatchEvent(event)
        prevented[type] = event.defaultPrevented
      }
      return { prevented, dropEffect: transfer.dropEffect }
    },
    { selector: target, imageName: name, base64: IMAGE_BASE64 }
  )
}

await runSuite(
  'sessions-open-feedback',
  async ({ app, agentDir, server, step }) => {
    const { cwd } = await app.openWorkspace()
    const directory = workspaceSessionDir(agentDir, cwd)
    const baselinePath = await longSession(cwd, { name: BASELINE_TITLE }).write(directory)
    const paths = new Map()
    for (const title of TITLES) {
      const session = new SessionBuilder({ cwd })
      session.modelChange()
      if (title !== 'Empty ready before commands') {
        session.user(`Question for ${title}`)
        session.assistant(`Answer for ${title}`)
      }
      session.name(title)
      paths.set(title, await session.write(directory))
    }
    const baseline = await app.test('openSession', baselinePath, 'pi')
    const row = (title) => app.page.locator('[data-session-row]', { hasText: title }).first()
    const opening = app.page.locator('[data-session-opening]')
    const answer = (title) =>
      app.page.locator('[data-transcript-scroll]').getByText(`Answer for ${title}`, { exact: true })
    const metrics = []
    await installDelays(app.app)

    try {
      await step(
        'mouse click acknowledges during rename delay and blocks the old composer while opening',
        async () => {
          const path = paths.get('Mouse open')
          await hold(app.app, path)
          const oldPane = await app.page.locator('[data-session-pane]').elementHandle()
          const measurement = await clickTiming(row('Mouse open'), true, () =>
            row('Mouse open').click()
          )
          await entered(app.app, path)
          await opening.waitFor()
          metrics.push({ input: 'mouse', ...measurement })
          assert.ok(
            measurement.acknowledgmentMs < MAX_ACKNOWLEDGMENT_MS,
            JSON.stringify(measurement)
          )
          assert.ok(measurement.openingMs >= DOUBLE_CLICK_WINDOW_MS)
          assert.equal(await oldPane.evaluate((element) => element.isConnected), true)
          assert.equal(await oldPane.evaluate((element) => !!element.closest('[inert]')), true)
          assert.equal(
            await app.page
              .locator('[data-session-pane] textarea[aria-label="Message"]')
              .isVisible(),
            false
          )
          await app.screenshot('opening-session-feedback', { settleMs: 0 })
          const blockedName = 'opening-drop.png'
          const drop = await dropImage(app, '[data-session-opening]', blockedName)
          assert.equal(drop.prevented.dragover, true)
          assert.equal(drop.prevented.drop, true)
          assert.equal(drop.dropEffect, 'none')
          assert.equal(await app.page.getByText('Drop to attach', { exact: true }).count(), 0)
          assert.equal(await app.page.getByText(blockedName, { exact: true }).count(), 0)
          await release(app.app, path)
          await answer('Mouse open').waitFor()
          await opening.waitFor({ state: 'hidden' })
          assert.equal(await app.page.getByText(blockedName, { exact: true }).count(), 0)
          await row(BASELINE_TITLE).focus()
          await row(BASELINE_TITLE).press('Enter')
          await app.page.locator('[data-session-pane] textarea[aria-label="Message"]').waitFor()
          assert.equal(await app.page.getByText(blockedName, { exact: true }).count(), 0)
          const visibleName = 'visible-drop.png'
          await dropImage(app, '[data-composer]', visibleName)
          const remove = app.page.getByRole('button', {
            name: `Remove ${visibleName}`,
            exact: true
          })
          await remove.waitFor()
          await remove.click()
        }
      )

      await step('double-click renames without opening an engine', async () => {
        const path = paths.get('Keyboard open')
        const before = (await app.invoke('engine:list')).length
        await row('Keyboard open').dblclick()
        const field = app.page.getByRole('textbox', { name: 'Session name', exact: true })
        await field.waitFor()
        await sleep(CANCELED_OPEN_WAIT_MS)
        assert.equal((await app.invoke('engine:list')).length, before)
        assert.ok(
          !(await app.invoke('engine:list')).some((entry) => entry.args.sessionPath === path)
        )
        await opening.waitFor({ state: 'hidden' })
        await field.press('Escape')
      })

      await step('F2 cancels a deferred click and renames without opening', async () => {
        const path = paths.get('F2 rename')
        await row('F2 rename').click()
        assert.equal(await row('F2 rename').getAttribute('aria-busy'), 'true')
        await row('F2 rename').press('F2')
        const field = app.page.getByRole('textbox', { name: 'Session name', exact: true })
        await field.waitFor()
        await sleep(CANCELED_OPEN_WAIT_MS)
        assert.ok(
          !(await app.invoke('engine:list')).some((entry) => entry.args.sessionPath === path)
        )
        assert.notEqual(
          await field
            .locator('xpath=ancestor::button[@data-session-row]')
            .getAttribute('aria-busy'),
          'true'
        )
        await field.press('Escape')
      })

      await step('keyboard opens immediately without the rename delay', async () => {
        const path = paths.get('Keyboard open')
        await hold(app.app, path)
        await row('Keyboard open').focus()
        const measurement = await clickTiming(row('Keyboard open'), false, () =>
          row('Keyboard open').press('Enter')
        )
        await entered(app.app, path)
        metrics.push({ input: 'keyboard', ...measurement })
        assert.ok(measurement.openingMs < MAX_ACKNOWLEDGMENT_MS, JSON.stringify(measurement))
        await release(app.app, path)
        await answer('Keyboard open').waitFor()
        await opening.waitFor({ state: 'hidden' })
      })

      await step('a newer keyboard selection cancels an older row timer', async () => {
        await row('Canceled timer').click()
        await row('Canceled timer')
          .getAttribute('aria-busy')
          .then((busy) => assert.equal(busy, 'true'))
        await row('Mouse open').focus()
        await row('Mouse open').press('Enter')
        await answer('Mouse open').waitFor()
        await sleep(CANCELED_OPEN_WAIT_MS)
        assert.ok(
          !(await app.invoke('engine:list')).some(
            (entry) => entry.args.sessionPath === paths.get('Canceled timer')
          )
        )
        assert.notEqual(await row('Canceled timer').getAttribute('aria-busy'), 'true')
      })

      await step('a newer mouse selection cancels an older row timer', async () => {
        await row('Canceled timer').click()
        await row('Mouse replacement').click()
        await answer('Mouse replacement').waitFor()
        await sleep(CANCELED_OPEN_WAIT_MS)
        assert.ok(
          !(await app.invoke('engine:list')).some(
            (entry) => entry.args.sessionPath === paths.get('Canceled timer')
          )
        )
        assert.notEqual(await row('Canceled timer').getAttribute('aria-busy'), 'true')
      })

      await step(
        'an older completion cannot clear a newer request or replace its selection',
        async () => {
          const older = paths.get('Older request')
          const newer = paths.get('Newer request')
          await hold(app.app, older)
          await hold(app.app, newer)
          await row('Older request').click()
          await entered(app.app, older)
          await row('Newer request').click()
          await entered(app.app, newer)
          await release(app.app, older)
          await until(
            async () =>
              (await app.invoke('engine:list')).some(
                (entry) => entry.args.sessionPath === older && entry.status === 'ready'
              ),
            { label: 'the older native engine finishes' }
          )
          await opening.waitFor()
          assert.equal(
            await app.page
              .locator('[data-session-pane] textarea[aria-label="Message"]')
              .isVisible(),
            false
          )
          await release(app.app, newer)
          await answer('Newer request').waitFor()
          await opening.waitFor({ state: 'hidden' })
          const active = await app.agentState()
          assert.equal(active.info.args.sessionPath, newer)
        }
      )

      await step(
        'a new composer receives initial focus after its held refresh finishes',
        async () => {
          const path = paths.get('Focus after refresh')
          const channel = 'engine:command:get_messages'
          await hold(app.app, path, channel)
          await row('Focus after refresh').click()
          await entered(app.app, path, channel)
          const active = await app.agentState()
          assert.equal(active.info.args.sessionPath, path)
          const pane = app.page.locator(`[data-session-pane][data-agent-id="${active.id}"]`)
          await pane.waitFor({ state: 'attached' })
          assert.equal(await pane.evaluate((element) => !!element.closest('[inert]')), true)
          await release(app.app, path, channel)
          await answer('Focus after refresh').waitFor()
          await opening.waitFor({ state: 'hidden' })
          await until(
            () =>
              app.page
                .locator('[data-session-pane] textarea[aria-label="Message"]')
                .evaluate((element) => document.activeElement === element),
            { label: 'the revealed new composer has initial focus' }
          )
        }
      )

      await step('committed history is usable while the command catalog is held', async () => {
        const path = paths.get('Ready before commands')
        const channel = 'engine:command:get_commands'
        await hold(app.app, path, channel)
        await row('Ready before commands').click()
        await entered(app.app, path, channel)
        await answer('Ready before commands').waitFor()
        await opening.waitFor({ state: 'hidden' })
        assert.equal((await app.agentState()).info.args.sessionPath, path)
        const composer = await app.composer()
        assert.equal(await composer.evaluate((element) => !!element.closest('[inert]')), false)
        await until(() => composer.evaluate((element) => document.activeElement === element), {
          label: 'the history-ready composer receives initial focus before catalog completion'
        })
        const count = (await app.invoke('engine:list')).length
        await composer.fill('/new')
        await composer.press('Enter')
        await app.page.getByText('Commands are still loading', { exact: true }).waitFor()
        assert.equal(await composer.inputValue(), '/new')
        assert.equal((await app.invoke('engine:list')).length, count)
        await release(app.app, path, channel)
        await until(
          async () => (await app.agentState()).commands.some((command) => command.name === 'new'),
          { label: 'the native shadow command catalog is committed' }
        )
        await composer.press('Enter')
        await app.page.getByText(SHADOW_COMMAND_NOTICE, { exact: true }).waitFor()
        assert.equal((await app.invoke('engine:list')).length, count)
        assert.equal((await app.agentState()).info.args.sessionPath, path)
      })

      await step(
        'duplicate opens and the open row keep waiting for committed history',
        async () => {
          const title = 'Joined history'
          const path = paths.get(title)
          const channel = 'engine:command:get_messages'
          await hold(app.app, path, channel)
          const first = app.test('openSession', path, 'pi')
          const joined = []
          try {
            await entered(app.app, path, channel)
            const count = (await app.invoke('engine:list')).length
            const duplicate = app.test('openSession', path, 'pi')
            joined.push(duplicate)
            assert.equal(
              await Promise.race([
                duplicate.then(() => 'finished'),
                sleep(CANCELED_OPEN_WAIT_MS).then(() => 'pending')
              ]),
              'pending'
            )
            await opening.waitFor()
            await row(title).click()
            await sleep(CANCELED_OPEN_WAIT_MS)
            await opening.waitFor()
            assert.equal((await app.invoke('engine:list')).length, count)
            assert.equal(
              await app.page
                .locator('[data-session-pane] textarea[aria-label="Message"]')
                .isVisible(),
              false
            )
          } finally {
            await release(app.app, path, channel)
            await Promise.allSettled([first, ...joined])
          }
          await answer(title).waitFor()
          await opening.waitFor({ state: 'hidden' })
        }
      )

      await step(
        'empty committed history is usable before command catalog completion',
        async () => {
          const title = 'Empty ready before commands'
          const path = paths.get(title)
          const channel = 'engine:command:get_commands'
          await hold(app.app, path, channel)
          await row(title).click()
          await entered(app.app, path, channel)
          await opening.waitFor({ state: 'hidden' })
          const active = await app.agentState()
          assert.equal(active.info.args.sessionPath, path)
          assert.equal(active.entries.length, 0)
          const composer = await app.composer()
          assert.equal(await composer.evaluate((element) => !!element.closest('[inert]')), false)
          await release(app.app, path, channel)
        }
      )

      await step('a failed command catalog keeps ambiguous command drafts', async () => {
        const title = 'Commands unavailable'
        const path = paths.get(title)
        const channel = 'engine:command:get_commands'
        await hold(app.app, path, channel)
        await row(title).click()
        await entered(app.app, path, channel)
        await answer(title).waitFor()
        await opening.waitFor({ state: 'hidden' })
        await rejectCatalog(app.app, path)
        await app.page.getByText('Could not open the session', { exact: true }).waitFor()
        const count = (await app.invoke('engine:list')).length
        const composer = await app.composer()
        await composer.fill('/new')
        await composer.press('Enter')
        await app.page.getByText('Commands could not be loaded', { exact: true }).waitFor()
        assert.equal(await composer.inputValue(), '/new')
        assert.equal((await app.invoke('engine:list')).length, count)
        assert.equal((await app.agentState()).info.args.sessionPath, path)
      })

      await step('a ready cached conversation opens without a pending layer', async () => {
        await opening.waitFor({ state: 'hidden' })
        const observation = await app.page.evaluateHandle(() => {
          const probe = { openingSeen: false, observer: null }
          probe.observer = new MutationObserver((changes) => {
            for (const change of changes) {
              for (const node of change.addedNodes) {
                if (
                  node instanceof Element &&
                  (node.matches('[data-session-opening]') ||
                    node.querySelector('[data-session-opening]'))
                ) {
                  probe.openingSeen = true
                }
              }
            }
          })
          probe.observer.observe(document.body, { subtree: true, childList: true })
          return probe
        })
        try {
          await app.test('openSession', paths.get('Mouse open'), 'pi')
          await answer('Mouse open').waitFor()
          assert.equal(await observation.evaluate((probe) => probe.openingSeen), false)
        } finally {
          await observation.evaluate((probe) => probe.observer.disconnect())
          await observation.dispose()
        }
      })

      await step(
        'the rename delay keeps deliberate sidebar focus through native opening',
        async () => {
          const path = paths.get('Keep focus during delay')
          await hold(app.app, path)
          await row('Keep focus during delay').click()
          assert.equal(await row('Keep focus during delay').getAttribute('aria-busy'), 'true')
          await row('Mouse open').focus()
          await entered(app.app, path)
          await release(app.app, path)
          await answer('Keep focus during delay').waitFor()
          await opening.waitFor({ state: 'hidden' })
          assert.equal(
            await row('Mouse open').evaluate((element) => document.activeElement === element),
            true
          )
        }
      )

      await step(
        'a slow create keeps deliberate sidebar focus before the new pane mounts',
        async () => {
          const path = paths.get('Keep focus before create')
          await hold(app.app, path)
          await row('Keep focus before create').click()
          await entered(app.app, path)
          await opening.waitFor()
          await row('Mouse open').focus()
          await release(app.app, path)
          await answer('Keep focus before create').waitFor()
          await opening.waitFor({ state: 'hidden' })
          assert.equal(
            await row('Mouse open').evaluate((element) => document.activeElement === element),
            true
          )
        }
      )

      await step('revealing a new composer keeps deliberate sidebar focus', async () => {
        const path = paths.get('Keep sidebar focus')
        const channel = 'engine:command:get_messages'
        await hold(app.app, path, channel)
        await row('Keep sidebar focus').click()
        await entered(app.app, path, channel)
        await app.page.locator('[data-session-pane][inert], [inert] [data-session-pane]').waitFor({
          state: 'attached'
        })
        await row('Mouse open').focus()
        await release(app.app, path, channel)
        await answer('Keep sidebar focus').waitFor()
        await opening.waitFor({ state: 'hidden' })
        assert.equal(
          await row('Mouse open').evaluate((element) => document.activeElement === element),
          true
        )
      })

      await step('revealing a new composer keeps deliberate Settings focus', async () => {
        const path = paths.get('Keep settings focus')
        const channel = 'engine:command:get_messages'
        await hold(app.app, path, channel)
        await row('Keep settings focus').click()
        await entered(app.app, path, channel)
        await app.page.locator('[data-session-pane][inert], [inert] [data-session-pane]').waitFor({
          state: 'attached'
        })
        await openSettings(app)
        const search = app.page.getByRole('textbox', { name: 'Search settings', exact: true })
        await search.focus()
        await release(app.app, path, channel)
        await answer('Keep settings focus').waitFor({ state: 'attached' })
        await opening.waitFor({ state: 'hidden' })
        assert.equal(await search.evaluate((element) => document.activeElement === element), true)
        await closeSettings(app)
      })

      await step('a failed open restores the same old pane and reader position', async () => {
        await row(BASELINE_TITLE).focus()
        await row(BASELINE_TITLE).press('Enter')
        await app.page
          .locator('[data-transcript-scroll]')
          .getByText('Step 59: what changed')
          .waitFor()
        const scroller = app.page.locator('[data-transcript-scroll]')
        await scroller.evaluate((element) => {
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
          element.scrollTop = 0
        })
        await scroller
          .getByText('Turn 0: tighten the request handling in area 0 and run its tests.', {
            exact: true
          })
          .waitFor()
        const original = await scroller.elementHandle()
        const top = await scroller.evaluate((element) => element.scrollTop)
        const path = paths.get('Failed open')
        await hold(app.app, path, 'sessions:describe')
        await row('Failed open').click()
        await entered(app.app, path, 'sessions:describe')
        await opening.waitFor()
        await rm(path)
        await release(app.app, path, 'sessions:describe')
        await app.page.getByText('Could not open the session', { exact: true }).waitFor()
        await opening.waitFor({ state: 'hidden' })
        assert.equal(await app.activeAgentId(), baseline)
        assert.equal(await original.evaluate((element) => element.isConnected), true)
        assert.equal(await original.evaluate((element) => element.scrollTop), top)
        await app.composer()
      })
      console.log(`      actual UI acknowledgment: ${JSON.stringify(metrics)}`)
      assert.equal(server.requests.length, 0, 'command probes do not send a model prompt')
      await mkdir(OUTPUT_DIRECTORY, { recursive: true })
      await writeFile(
        join(OUTPUT_DIRECTORY, 'metrics.json'),
        `${JSON.stringify(metrics, null, 2)}\n`
      )
    } finally {
      await app.app.evaluate(() => globalThis.__restoreOpenFeedback?.())
    }
  },
  {
    agentDir: { files: { 'extensions/qa-opening-shadow.ts': SHADOW_COMMAND_EXTENSION } },
    launch: { outDir: OUTPUT_DIRECTORY, exe: process.env.QA_PACKAGED_EXE }
  }
)
