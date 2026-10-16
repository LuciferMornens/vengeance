// Chat: every built-in tool of the Engine (read, bash, edit, write, grep, find, ls, powershell)
// driven by the fake LLM. Each call is checked end to end: the result the model gets back, the
// effect on disk, and the tool row (verb, subject, expand, Copy, Raw, edit diff, read image
// thumbnail, live bash output).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  assertCleanUiText,
  makePng,
  pickModelInFooter,
  softSteps,
  transcriptText,
  until
} from './helpers.mjs'

const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell']

const APP_TS = ['export function add(a: number, b: number) {', '  return a + b', '}', ''].join('\n')

/** Queue a tool call + a closing text turn, send `prompt`; the result the model got + the execution. */
async function runTool(app, server, { id, name, args, prompt, answer = `${name} done.` }) {
  const from = server.requests.length
  server.queue(turn.toolCalls([{ id, name, args }]), turn.text(answer))
  await app.send(prompt)
  await app.waitForSettle()
  const followUp = await server.waitForRequest(
    (request) => inspectRequest(request).toolResults.some((r) => r.toolCallId === id),
    { from }
  )
  const result = inspectRequest(followUp).toolResults.find((r) => r.toolCallId === id)
  const execution = (await app.agentState()).tools[id]
  return { result, execution }
}

/** The newest tool row (rows are in transcript order). */
async function lastRow(app) {
  return app.page.locator('[data-tool-row]').last()
}

async function expand(row) {
  const toggle = row.locator('button[aria-expanded]').first()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await row.locator('[data-row-detail]').waitFor()
  return row.locator('[data-row-detail]')
}

const clipboardText = (app) => app.app.evaluate(({ clipboard }) => clipboard.readText())

await runSuite(
  'chat-tools',
  async ({ server, app, step }) => {
    const checks = softSteps(step, app)
    let cwd

    await step('open with every built-in tool enabled', async () => {
      ;({ cwd } = await app.openWorkspace({
        files: {
          'README.md': '# Tools workspace\n',
          'src/app.ts': APP_TS,
          'notes.txt': 'first line\nthe needle is here\nlast line\n',
          'pixel.png': makePng(16, 16)
        },
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.vision}` }
      }))
      server.queue(turn.text('ready'))
      await app.send('hello')
      await app.waitForSettle()
      const sent = inspectRequest(server.requests.at(-1))
      for (const tool of BUILTIN_TOOLS) {
        assert.ok(sent.tools.includes(tool), `${tool} declared (tools: ${sent.tools.join(', ')})`)
      }
    })

    await step(
      'read: content to the model, row "Read src/app.ts · 3 lines", Copy, Raw',
      async () => {
        const { result, execution } = await runTool(app, server, {
          id: 'toolu_read',
          name: 'read',
          args: { path: 'src/app.ts' },
          prompt: 'Read app.ts'
        })
        assert.equal(result.isError, false)
        assert.match(result.text, /return a \+ b/)
        assert.equal(execution.status, 'done')
        const row = await lastRow(app)
        const rowText = await row.innerText()
        assert.match(rowText, /^Read/)
        assert.match(rowText, /app\.ts/)
        assert.match(rowText, /3 lines/)
        const detail = await expand(row)
        await detail.getByText('return a + b').waitFor()
        await detail.getByRole('button', { name: /Copy/ }).click()
        await until(async () => (await clipboardText(app)).includes('return a + b'), {
          label: 'clipboard holds the file'
        })
        await detail.getByRole('button', { name: 'Raw' }).click()
        await detail.getByText('Arguments · read').waitFor()
        await detail.getByText('Result text').waitFor()
        await app.screenshot('tool-read-raw')
        await detail.getByRole('button', { name: 'Raw' }).click()
      }
    )

    await step(
      'read an image on qa-vision: image block to the model, thumbnail in the row',
      async () => {
        const { result } = await runTool(app, server, {
          id: 'toolu_read_png',
          name: 'read',
          args: { path: 'pixel.png' },
          prompt: 'Read the png'
        })
        assert.equal(result.isError, false)
        assert.equal(result.images, 1, 'tool result carries one image')
        const row = await lastRow(app)
        assert.match(await row.innerText(), /Image/)
        assert.equal((await row.locator('img').count()) >= 1, true, 'thumbnail')
        const detail = await expand(row)
        await detail.locator('img').first().waitFor()
        await app.screenshot('tool-read-image')
      }
    )

    await step('read an image on a text-only model: note instead of the image', async () => {
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.reasoning)
      const { result } = await runTool(app, server, {
        id: 'toolu_read_png_text',
        name: 'read',
        args: { path: 'pixel.png' },
        prompt: 'Read the png without vision'
      })
      assert.equal(result.images, 0, 'no image block for a text-only model')
      assert.match(result.text, /does not support images/)
    })

    await step('read a missing file: error result, danger subline', async () => {
      const { result, execution } = await runTool(app, server, {
        id: 'toolu_read_missing',
        name: 'read',
        args: { path: 'missing.txt' },
        prompt: 'Read a missing file'
      })
      assert.equal(result.isError, true)
      assert.equal(execution.status, 'error')
      const row = await lastRow(app)
      assert.match(await row.innerText(), /ENOENT|not found|no such file/i)
      assertCleanUiText(await row.innerText())
    })

    await checks.check(
      'missing-file subline is readable (no errno code, no temp path)',
      async () => {
        const subline = await (await lastRow(app)).innerText()
        await app.screenshot('tool-read-missing')
        assert.doesNotMatch(subline, /ENOENT|[\\/]Temp[\\/]vengeance-qa-/, subline)
      }
    )

    await step('bash: output streams into the live tail, then the full output', async () => {
      const from = server.requests.length
      server.queue(
        turn.toolCalls([
          {
            id: 'toolu_bash_stream',
            name: 'bash',
            args: { command: 'for i in 1 2 3 4 5 6; do echo line$i; sleep 0.4; done' }
          }
        ]),
        turn.text('bash streamed.')
      )
      await app.send('Stream some output')
      const tail = app.page.locator('[data-live-tail]')
      await tail.getByText('line2').waitFor({ timeout: 15_000 })
      const partial = (await app.agentState()).tools.toolu_bash_stream
      assert.equal(partial.status, 'running')
      assert.doesNotMatch(await tail.innerText(), /line6/, 'tail shows output before the end')
      await app.screenshot('tool-bash-live-tail')
      await app.waitForSettle()
      const followUp = server.requests.slice(from)[1]
      const result = inspectRequest(followUp).toolResults.find(
        (r) => r.toolCallId === 'toolu_bash_stream'
      )
      assert.match(result.text, /line1[\s\S]*line6/)
      const row = await lastRow(app)
      const detail = await expand(row)
      await detail.getByText('line6').waitFor()
    })

    await step('bash failure: exit code shown, error result', async () => {
      const { result, execution } = await runTool(app, server, {
        id: 'toolu_bash_fail',
        name: 'bash',
        args: { command: 'echo boom >&2; exit 3' },
        prompt: 'Fail a command'
      })
      assert.equal(result.isError, true)
      assert.match(result.text, /boom/)
      assert.equal(execution.status, 'error')
      const row = await lastRow(app)
      assert.match(await row.innerText(), /3/)
    })

    await step('edit: file changes on disk, row "Edited" with +/− stats and a diff', async () => {
      const { result } = await runTool(app, server, {
        id: 'toolu_edit',
        name: 'edit',
        args: {
          path: 'src/app.ts',
          edits: [{ oldText: '  return a + b', newText: '  return a + b + 0 // edited' }]
        },
        prompt: 'Edit app.ts'
      })
      assert.equal(result.isError, false, result.text)
      assert.match(await readFile(join(cwd, 'src', 'app.ts'), 'utf8'), /\/\/ edited/)
      const row = await lastRow(app)
      const rowText = await row.innerText()
      assert.match(rowText, /^Edited/)
      assert.match(rowText, /\+1/)
      assert.match(rowText, /−1/)
      const detail = await expand(row)
      await detail.getByText('// edited').waitFor()
      await app.screenshot('tool-edit-diff')
    })

    await step('edit with a non-matching oldText: error result, file untouched', async () => {
      const before = await readFile(join(cwd, 'src', 'app.ts'), 'utf8')
      const { result, execution } = await runTool(app, server, {
        id: 'toolu_edit_bad',
        name: 'edit',
        args: { path: 'src/app.ts', edits: [{ oldText: 'not in the file', newText: 'x' }] },
        prompt: 'Bad edit'
      })
      assert.equal(result.isError, true)
      assert.equal(execution.status, 'error')
      assert.equal(await readFile(join(cwd, 'src', 'app.ts'), 'utf8'), before)
    })

    await step('write: new file on disk, row "Created"', async () => {
      const { result } = await runTool(app, server, {
        id: 'toolu_write',
        name: 'write',
        args: { path: 'out/new.md', content: '# Written by the agent\n' },
        prompt: 'Write a file'
      })
      assert.equal(result.isError, false, result.text)
      assert.equal(await readFile(join(cwd, 'out', 'new.md'), 'utf8'), '# Written by the agent\n')
      const row = await lastRow(app)
      assert.match(await row.innerText(), /^Created/)
      const detail = await expand(row)
      await detail.getByText('Written by the agent').waitFor()
    })

    await step('write over an existing file: row "Wrote"', async () => {
      const { result } = await runTool(app, server, {
        id: 'toolu_rewrite',
        name: 'write',
        args: { path: 'out/new.md', content: '# Rewritten\n' },
        prompt: 'Rewrite a file'
      })
      assert.equal(result.isError, false)
      assert.match(await (await lastRow(app)).innerText(), /^Wrote/)
    })

    await step('grep: matches to the model, row "Searched"', async () => {
      const { result } = await runTool(app, server, {
        id: 'toolu_grep',
        name: 'grep',
        args: { pattern: 'needle' },
        prompt: 'Grep for needle'
      })
      assert.equal(result.isError, false, result.text)
      assert.match(result.text, /notes\.txt/)
      assert.match(result.text, /the needle is here/)
      const row = await lastRow(app)
      assert.match(await row.innerText(), /^Searched/)
      const detail = await expand(row)
      await detail
        .getByText(/needle is here/)
        .first()
        .waitFor()
    })

    await step('find: paths to the model, row "Found"', async () => {
      const { result } = await runTool(app, server, {
        id: 'toolu_find',
        name: 'find',
        args: { pattern: '*.ts' },
        prompt: 'Find ts files'
      })
      assert.equal(result.isError, false, result.text)
      assert.match(result.text, /app\.ts/)
      assert.match(await (await lastRow(app)).innerText(), /^Found/)
    })

    await step('ls: listing to the model, row "Listed"', async () => {
      const { result } = await runTool(app, server, {
        id: 'toolu_ls',
        name: 'ls',
        args: { path: '.' },
        prompt: 'List the folder'
      })
      assert.equal(result.isError, false, result.text)
      assert.match(result.text, /README\.md/)
      assert.match(result.text, /src\//)
      assert.match(await (await lastRow(app)).innerText(), /^Listed/)
    })

    await step('powershell: runs, output to the model, PS row', async () => {
      const { result } = await runTool(app, server, {
        id: 'toolu_ps',
        name: 'powershell',
        args: { command: 'Write-Output "hello-from-ps"' },
        prompt: 'Run powershell'
      })
      assert.equal(result.isError, false, result.text)
      assert.match(result.text, /hello-from-ps/)
      const detail = await expand(await lastRow(app))
      await detail.getByText('hello-from-ps').first().waitFor()
    })

    await step('two calls in one turn: both results in the next request', async () => {
      const from = server.requests.length
      server.queue(
        turn.toolCalls([
          { id: 'toolu_par_read', name: 'read', args: { path: 'README.md' } },
          { id: 'toolu_par_ls', name: 'ls', args: { path: 'src' } }
        ]),
        turn.text('Both done.')
      )
      await app.send('Two tools at once')
      await app.waitForSettle()
      const followUp = server.requests.slice(from)[1]
      const ids = inspectRequest(followUp).toolResults.map((r) => r.toolCallId)
      assert.ok(ids.includes('toolu_par_read') && ids.includes('toolu_par_ls'), ids.join(', '))
    })

    await step(
      'unknown tool name: error result back to the model, row shows the failure',
      async () => {
        const { result, execution } = await runTool(app, server, {
          id: 'toolu_unknown',
          name: 'no_such_tool',
          args: { x: 1 },
          prompt: 'Call a tool that does not exist'
        })
        assert.equal(result.isError, true)
        assert.match(result.text, /not found|unknown/i)
        assert.equal(execution.status, 'error')
        await app.screenshot('tool-unknown')
      }
    )

    await step('Ctrl+O expands every tool row', async () => {
      await app.page.getByRole('textbox', { name: 'Message' }).focus()
      await app.page.keyboard.press('Control+o')
      await until(async () => (await app.page.locator('[data-row-detail]').count()) >= 10, {
        label: 'all rows expanded'
      })
      await app.screenshot('tools-expanded')
      await app.page.keyboard.press('Control+o')
    })

    await checks.check('transcript copy is clean (no "pi", no raw JSON)', async () => {
      const text = await transcriptText(app)
      assertCleanUiText(text, { allow: [/Arguments · read[\s\S]*?Result text/] })
    })

    await checks.check('no app errors', async () => app.assertNoErrors())
    checks.assertAll()
  },
  {
    launch: { outDir: SHOTS_DIR },
    agentDir: { settings: { defaultTools: BUILTIN_TOOLS } }
  }
)
