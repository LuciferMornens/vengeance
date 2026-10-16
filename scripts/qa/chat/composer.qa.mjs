// Chat: composer input end to end. `!cmd` / `!!cmd` user bash (in or out of context, checked in
// the next request), @file mentions, image paste / drop / attach (vision and text-only models),
// multi-line input and the prompt-history keys.
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  composer,
  makePng,
  pickModelInFooter,
  sendAndCapture,
  sleep,
  softSteps,
  transcriptText,
  until
} from './helpers.mjs'

const PNG_BASE64 = makePng(24, 24, [40, 120, 220]).toString('base64')

/** Fire a paste (or a window drop) of a PNG File at the composer, like the OS would. */
async function deliverImage(app, how, name) {
  await app.page.evaluate(
    ({ base64, how: kind, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const file = new File([bytes], fileName, { type: 'image/png' })
      const data = new DataTransfer()
      data.items.add(file)
      const textarea = document.querySelector('textarea[aria-label="Message"]')
      if (kind === 'paste') {
        textarea.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
        )
      } else {
        for (const type of ['dragenter', 'dragover', 'drop']) {
          window.dispatchEvent(
            new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true })
          )
        }
      }
    },
    { base64: PNG_BASE64, how, fileName: name }
  )
  await app.page.getByText(name).first().waitFor()
  await until(async () => (await app.page.locator('[data-composer] img').count()) > 0, {
    label: 'attachment thumbnail'
  })
}

async function sendWithAttachments(app, server, text) {
  const from = server.requests.length
  await composer(app).fill(text)
  await composer(app).press('Enter')
  const request = await server.waitForRequest(undefined, { from })
  await app.waitForSettle()
  return inspectRequest(request)
}

await runSuite(
  'chat-composer',
  async ({ server, app, step }) => {
    const checks = softSteps(step, app)
    let cwd

    await step('open on qa-vision', async () => {
      ;({ cwd } = await app.openWorkspace({
        files: {
          'README.md': '# Composer workspace\n',
          'docs/notes.txt': 'notes body\n',
          'shot.png': makePng(10, 10)
        },
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.vision}` }
      }))
    })

    await step('!cmd runs in the shell, shows "You ran", and enters the next request', async () => {
      const box = await composer(app)
      await box.fill('!echo bang-included-output')
      await app.page.getByText('Shell · output added to context').waitFor()
      await box.press('Enter')
      await app.page.getByText('You ran').first().waitFor()
      await app.page.getByText('bang-included-output').first().waitFor()
      assert.equal(server.requests.length, 0, 'a user command makes no model request')
      const { messages } = await app.rpc({ type: 'get_messages' })
      const bash = messages.find((m) => m.role === 'bashExecution')
      assert.equal(bash?.command, 'echo bang-included-output')
      assert.notEqual(bash?.excludeFromContext, true)
      const { sent } = await sendAndCapture(app, server, 'What did my command print?')
      const all = sent.messages.map((m) => m.text).join('\n')
      assert.match(all, /bang-included-output/, 'output in the model context')
      await app.screenshot('composer-bang')
    })

    await step('!!cmd runs but stays out of the next request', async () => {
      const box = await composer(app)
      await box.fill('!!echo bang-excluded-output')
      await app.page.getByText('Shell · output kept out of context').waitFor()
      await box.press('Enter')
      await app.page.getByText('bang-excluded-output').first().waitFor()
      const { sent } = await sendAndCapture(app, server, 'Anything new?')
      const all = sent.messages.map((m) => m.text).join('\n')
      assert.doesNotMatch(all, /bang-excluded-output/, 'excluded output not sent')
      assert.match(all, /bang-included-output/, 'the included one still is')
    })

    await checks.check('"You ran" cards stay where they ran, before the later turns', async () => {
      await app.screenshot('composer-bang-order')
      const text = await transcriptText(app)
      const ran = text.indexOf('bang-included-output')
      const later = text.indexOf('What did my command print?')
      assert.ok(ran >= 0 && later >= 0, 'both visible')
      assert.ok(ran < later, 'the !cmd card comes before the prompt that followed it')
    })

    await step('a long !cmd shows the running row with Stop, and Stop ends it', async () => {
      const box = await composer(app)
      await box.fill('!sleep 20')
      await box.press('Enter')
      const stop = app.page
        .locator('[data-composer]')
        .getByRole('button', { name: 'Stop', exact: true })
      await stop.first().waitFor()
      await app.screenshot('composer-bang-running')
      await stop.first().click()
      await until(
        async () => !Object.values((await app.agentState()).bash).some((r) => r.running),
        {
          label: 'user bash stopped',
          timeoutMs: 10_000
        }
      )
    })

    await step(
      '@ mention: menu lists files, Enter inserts the path, the request carries it',
      async () => {
        const box = await composer(app)
        await box.fill('')
        await box.pressSequentially('Look at @notes')
        await app.page.getByText('notes.txt', { exact: true }).first().waitFor()
        await app.screenshot('composer-mention-menu')
        await box.press('Enter')
        await until(async () => /@docs\/notes\.txt /.test(await box.inputValue()), {
          label: 'path inserted'
        })
        await box.pressSequentially('please')
        const from = server.requests.length
        await box.press('Enter')
        const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
        await app.waitForSettle()
        assert.equal(sent.lastUserText, 'Look at @docs/notes.txt please')
      }
    )

    await step('paste an image: thumbnail chip, one image block on qa-vision', async () => {
      await deliverImage(app, 'paste', 'pasted.png')
      await app.screenshot('composer-image-pasted')
      const sent = await sendWithAttachments(app, server, 'What is in the pasted image?')
      assert.equal(sent.imageCount, 1)
      assert.equal(sent.messages.at(-1).images, 1, 'image on the last user message')
      assert.equal(await app.page.locator('[data-composer] img').count(), 0, 'tray cleared')
    })

    await step('drop an image file: attached and sent', async () => {
      await deliverImage(app, 'drop', 'dropped.png')
      const sent = await sendWithAttachments(app, server, 'And the dropped one?')
      assert.equal(sent.messages.at(-1).images, 1)
    })

    await step(
      'Attach button (file dialog stubbed): image attached, other files become @mentions',
      async () => {
        const picked = [`${cwd}\\shot.png`, `${cwd}\\README.md`]
        await app.app.evaluate(({ ipcMain }, paths) => {
          ipcMain.removeHandler('sys:pick-files')
          // The app's handle() wraps results in an { ok, value } envelope.
          ipcMain.handle('sys:pick-files', () => ({ ok: true, value: paths }))
        }, picked)
        await app.page.getByRole('button', { name: 'Attach images or files' }).click()
        await app.page.getByText('shot.png').first().waitFor()
        await until(async () => (await app.page.locator('[data-composer] img').count()) > 0, {
          label: 'shot.png prepared'
        })
        await until(async () => /@README\.md/.test(await composer(app).inputValue()), {
          label: '@README.md inserted'
        })
        const from = server.requests.length
        await composer(app).press('Enter')
        const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
        await app.waitForSettle()
        assert.equal(sent.messages.at(-1).images, 1)
        assert.match(sent.lastUserText, /@README\.md/)
      }
    )

    await checks.check('text-only model: a warning in the tray, no image block sent', async () => {
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.reasoning)
      await deliverImage(app, 'paste', 'unsupported.png')
      await app.page.getByText(/can.t read images/).waitFor()
      await app.screenshot('composer-image-non-vision')
      const sent = await sendWithAttachments(app, server, 'Image on a text model')
      assert.equal(sent.messages.at(-1).images, 0, 'no image block for a text-only model')
      const last = (await app.agentState()).entries.at(-1).message
      assert.notEqual(last.stopReason, 'error', 'the turn did not fail')
    })

    await step('Shift+Enter makes a new line; the request keeps it', async () => {
      const box = await composer(app)
      await box.fill('')
      await box.pressSequentially('line one')
      await box.press('Shift+Enter')
      await box.pressSequentially('line two')
      assert.equal(await box.inputValue(), 'line one\nline two')
      const from = server.requests.length
      await box.press('Enter')
      const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
      await app.waitForSettle()
      assert.equal(sent.lastUserText, 'line one\nline two')
    })

    await step('history: Up recalls older prompts, Down walks back to the draft', async () => {
      const box = await composer(app)
      await box.fill('')
      await box.press('ArrowUp')
      assert.equal(await box.inputValue(), 'line one\nline two')
      // The caret lands at the end; Up on the first line of a multi-line entry goes further back.
      await box.press('Control+Home')
      await box.press('ArrowUp')
      assert.equal(await box.inputValue(), 'Image on a text model')
      await box.press('ArrowDown')
      assert.equal(await box.inputValue(), 'line one\nline two')
      await box.press('Control+End')
      await box.press('ArrowDown')
      assert.equal(await box.inputValue(), '', 'back to the empty draft')
    })

    await step('the "!" history entry recalls the command text', async () => {
      const box = await composer(app)
      for (let i = 0; i < 12; i++) {
        await box.press('Control+Home')
        await box.press('ArrowUp')
        if ((await box.inputValue()) === '!!echo bang-excluded-output') break
      }
      assert.equal(await box.inputValue(), '!!echo bang-excluded-output')
      await box.fill('')
      await sleep(100)
    })

    await checks.check('no app errors', async () => app.assertNoErrors())
    checks.assertAll()
  },
  { launch: { outDir: SHOTS_DIR } }
)
