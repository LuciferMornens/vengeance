// Chat: every built-in slash command the composer offers, run through the real composer, each
// checked for its effect (engine state, disk, clipboard, the dialog it opens). The checklist is the
// Engine's docs/slash-commands.md; commands it has that the composer does not offer fail a step.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  closePalette,
  composer,
  sendAndCapture,
  sleep,
  softSteps,
  submitCommand,
  until
} from './helpers.mjs'

/** docs/slash-commands.md (Engine 1.1.0), built-in commands. */
const ENGINE_COMMANDS = [
  'settings',
  'model',
  'thinking',
  'scoped-models',
  'login',
  'logout',
  'llama',
  'new',
  'resume',
  'name',
  'session',
  'tree',
  'fork',
  'clone',
  'compact',
  'import',
  'copy',
  'export',
  'share',
  'bug',
  'trust',
  'reload',
  'hotkeys',
  'changelog',
  'quit'
]

const dialog = (app) => app.page.getByRole('dialog')

async function closeDialogs(app) {
  for (let i = 0; i < 4 && (await dialog(app).count()) > 0; i++) {
    await app.page.keyboard.press('Escape')
    await sleep(200)
  }
}

async function dialogTitle(app) {
  await dialog(app).first().waitFor()
  return (await dialog(app).first().innerText()).split('\n')[0]
}

const clipboardText = (app) => app.app.evaluate(({ clipboard }) => clipboard.readText())

await runSuite(
  'chat-slash',
  async ({ server, app, step }) => {
    const checks = softSteps(step, app)
    let cwd

    await step('open and have one exchange', async () => {
      ;({ cwd } = await app.openWorkspace({
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, thinking: 'off' }
      }))
      server.queue(turn.text('The **first** answer.'))
      await sendAndCapture(app, server, 'First question')
    })

    await step('"/" lists the built-in commands', async () => {
      const box = composer(app)
      await box.fill('/')
      await app.page.getByRole('listbox', { name: 'Commands' }).waitFor()
      await app.screenshot('slash-menu')
      await box.fill('')
    })

    await checks.check('every Engine built-in command is offered', async () => {
      const missing = []
      for (const name of ENGINE_COMMANDS) {
        await composer(app).fill(`/${name}`)
        await sleep(150)
        const options = await app.page
          .getByRole('listbox', { name: 'Commands' })
          .getByRole('option')
          .allInnerTexts()
        const offered = options.some(
          (text) => text.trim().split(/\s+/)[0].replace(/^\//, '') === name
        )
        if (!offered) {
          missing.push(name)
        }
      }
      await composer(app).fill('')
      assert.deepEqual(missing, [], `missing: ${missing.join(', ')}`)
    })

    await step('/settings opens Settings', async () => {
      await submitCommand(app, '/settings')
      await app.page.getByText('Agent behavior', { exact: true }).first().waitFor()
      await closeDialogs(app)
    })

    await step('/thinking high sets the level; the request follows', async () => {
      await submitCommand(app, '/thinking high')
      await until(async () => (await app.rpc({ type: 'get_state' })).thinkingLevel === 'high', {
        label: 'engine high'
      })
      const { sent } = await sendAndCapture(app, server, 'thinking via slash')
      assert.equal(sent.thinking?.budget_tokens, 16384)
    })

    await step('/thinking bogus warns with the available levels', async () => {
      await submitCommand(app, '/thinking bogus')
      await app.page.getByText(/Unknown thinking level/).waitFor()
      await app.page.getByText(/Available: off, minimal, low, medium, high/).waitFor()
    })

    await step('/thinking with no level opens the palette thinking page', async () => {
      await submitCommand(app, '/thinking')
      await app.page.getByPlaceholder('Choose a thinking level…').waitFor()
      await closePalette(app)
    })

    await step('/scoped-models opens the models setting (enabledModels)', async () => {
      await submitCommand(app, '/scoped-models')
      await dialog(app).first().waitFor()
      await app.screenshot('slash-scoped-models')
      const text = await dialog(app).first().innerText()
      assert.match(text, /cycl|scoped|Ctrl\+P/i)
      await closeDialogs(app)
    })

    await step('/login and /logout open the providers settings', async () => {
      await submitCommand(app, '/login')
      await dialog(app).first().waitFor()
      assert.match(await dialog(app).first().innerText(), /Anthropic|Provider/i)
      await app.screenshot('slash-login')
      await closeDialogs(app)
      await submitCommand(app, '/logout')
      await dialog(app).first().waitFor()
      assert.match(await dialog(app).first().innerText(), /Anthropic|Provider/i)
      await closeDialogs(app)
    })

    await step('/name sets the session name in the engine and the header', async () => {
      await submitCommand(app, '/name QA renamed session')
      await until(
        async () => (await app.rpc({ type: 'get_state' })).sessionName === 'QA renamed session',
        { label: 'engine session name' }
      )
      await app.page
        .locator('[data-session-title]', { hasText: 'QA renamed session' })
        .first()
        .waitFor()
    })

    await step('/session shows session info with the file and token stats', async () => {
      await submitCommand(app, '/session')
      await dialog(app).first().waitFor()
      const text = await dialog(app).first().innerText()
      await app.screenshot('slash-session')
      const stats = await app.rpc({ type: 'get_session_stats' })
      assert.match(text, /QA renamed session/)
      assert.match(text, new RegExp(String(stats.userMessages)), 'user message count shown')
      await closeDialogs(app)
    })

    await step('/copy puts the last answer on the clipboard', async () => {
      await app.app.evaluate(({ clipboard }) => clipboard.writeText('before'))
      await submitCommand(app, '/copy')
      const { text } = await app.rpc({ type: 'get_last_assistant_text' })
      await until(async () => (await clipboardText(app)) === text, {
        label: 'clipboard = last answer'
      })
    })

    await step('/export out.html and /export out.jsonl write files in the workspace', async () => {
      await submitCommand(app, '/export qa-export.html')
      await until(() => existsSync(join(cwd, 'qa-export.html')), { label: 'html written' })
      // The engine's HTML viewer embeds the session data (encoded), so check the page itself.
      assert.match(await readFile(join(cwd, 'qa-export.html'), 'utf8'), /<html/i)
      await submitCommand(app, '/export qa-export.jsonl')
      await until(() => existsSync(join(cwd, 'qa-export.jsonl')), { label: 'jsonl written' })
      const lines = (await readFile(join(cwd, 'qa-export.jsonl'), 'utf8')).trim().split('\n')
      assert.equal(JSON.parse(lines[0]).type, 'session')
    })

    await step('/share opens the share dialog (closed without uploading)', async () => {
      await submitCommand(app, '/share')
      const title = await dialogTitle(app)
      await app.screenshot('slash-share')
      assert.match(title, /Share/i)
      await closeDialogs(app)
    })

    await step('/hotkeys opens the shortcuts sheet', async () => {
      await submitCommand(app, '/hotkeys')
      await app.page.getByText('Keyboard shortcuts').first().waitFor()
      await closeDialogs(app)
    })

    await step('/changelog opens the engine changelog', async () => {
      await submitCommand(app, '/changelog')
      await app.page.getByText('What’s new in the engine').first().waitFor()
      await app.screenshot('slash-changelog')
      await closeDialogs(app)
    })

    await step('/trust opens the project trust dialog', async () => {
      await submitCommand(app, '/trust')
      await dialog(app).first().waitFor()
      await app.screenshot('slash-trust')
      await closeDialogs(app)
    })

    await step('/reload reloads in place ("Reloaded")', async () => {
      await submitCommand(app, '/reload')
      await app.page.getByText('Reloaded', { exact: true }).waitFor({ timeout: 20_000 })
      await app.waitForSettle()
    })

    await step('/tree opens the session tree', async () => {
      await submitCommand(app, '/tree')
      await app.page.getByText('First question').nth(1).waitFor()
      await app.screenshot('slash-tree')
      await app.page.keyboard.press('Escape')
    })

    await step('/fork opens the fork picker listing earlier user messages', async () => {
      await submitCommand(app, '/fork')
      await app.page.getByText('Fork from a message').waitFor()
      await dialog(app).getByText('First question').first().waitFor()
      await app.screenshot('slash-fork')
      await closeDialogs(app)
    })

    await step('/resume focuses the session browser search', async () => {
      await submitCommand(app, '/resume')
      await until(
        () =>
          app.page.evaluate(
            () => document.activeElement?.getAttribute('placeholder') === 'Search sessions'
          ),
        { label: 'session search focused' }
      )
    })

    await step('/clone duplicates the session into a new one', async () => {
      // The engine clones in place: same agent, a new session file.
      const before = (await app.rpc({ type: 'get_state' })).sessionFile
      await submitCommand(app, '/clone')
      await until(async () => (await app.rpc({ type: 'get_state' })).sessionFile !== before, {
        label: 'clone session file'
      })
      await app.page.getByText('Session cloned').waitFor()
      await app.page.getByText('First question').first().waitFor()
      const { messages } = await app.rpc({ type: 'get_messages' })
      assert.ok(
        messages.some((m) => m.role === 'user'),
        'clone carries the conversation'
      )
    })

    await step(
      '/import (file dialog stubbed): review, Import and open loads the conversation',
      async () => {
        const file = join(cwd, 'qa-export.jsonl')
        await app.app.evaluate(({ dialog: electronDialog }, path) => {
          electronDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
        }, file)
        await submitCommand(app, '/import')
        await app.page.getByText('Import a session').waitFor()
        await app.screenshot('slash-import')
        const before = await app.activeAgentId()
        await app.page.getByRole('button', { name: 'Import and open' }).click()
        await until(async () => (await app.activeAgentId()) !== before, {
          label: 'imported session'
        })
        await app.page.getByText('Session imported').waitFor()
        await until(async () => (await app.agentState())?.status === 'ready', { label: 'ready' })
        const { messages } = await app.rpc({ type: 'get_messages' })
        assert.ok(
          messages.some(
            (m) => m.role === 'user' && JSON.stringify(m.content).includes('First question')
          ),
          'imported conversation loaded'
        )
        await until(async () => (await app.page.locator('[data-session-pane]').count()) === 1, {
          label: 'one session pane'
        })
      }
    )

    await step('/new starts an empty session; the next request has no history', async () => {
      const before = (await app.rpc({ type: 'get_state' })).sessionId
      await submitCommand(app, '/new')
      await until(async () => (await app.rpc({ type: 'get_state' })).sessionId !== before, {
        label: 'new session id'
      })
      // /new opens another session; wait for the outgoing pane's exit fade.
      await until(async () => (await app.page.locator('[data-session-pane]').count()) === 1, {
        label: 'one session pane'
      })
      const from = server.requests.length
      const box = composer(app)
      await box.fill('Fresh start')
      await box.press('Enter')
      const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
      await app.waitForSettle()
      assert.deepEqual(
        sent.messages.map((m) => m.text),
        ['Fresh start'],
        'only the new prompt is sent'
      )
      assert.ok(
        !server.requests.some((r) => inspectRequest(r).lastUserText.startsWith('/')),
        'no slash command ever reached the model'
      )
    })

    await checks.check('no app errors', async () => app.assertNoErrors())
    await step('/quit closes the window', async () => {
      const closed = app.app.waitForEvent('close', { timeout: 15_000 })
      const box = composer(app)
      await box.fill('/quit')
      // The window may close before the key press resolves.
      await box.press('Enter').catch(() => undefined)
      await closed
    })

    checks.assertAll()
  },
  { launch: { outDir: SHOTS_DIR } }
)
