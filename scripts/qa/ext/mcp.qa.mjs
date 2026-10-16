// MCP end to end: the Settings → MCP editor (add, edit, exposure, project override, remove), a
// project .pi/mcp.json server behind project trust, the stdio fixture server's tools and resources
// called by the fake LLM, env and HTTP headers reaching the servers, connection status, a failing
// server, and "Reconnect in open sessions".
//
//   node scripts/qa/ext/mcp.qa.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { bugSteps, FIXTURES_DIR, reportShot, submitComposer, until } from './lib/ext-helpers.mjs'
import { handleMcpMessage } from './fixtures/qa-mcp-server.mjs'

const SERVER = join(FIXTURES_DIR, 'qa-mcp-server.mjs')
const HTTP_TOKEN = 'qa-http-secret'

/** Streamable-HTTP variant of the fixture, hosted in this process; records request headers. */
async function startHttpMcp() {
  const seen = []
  const server = createServer((request, response) => {
    seen.push({ method: request.method, headers: request.headers })
    if (request.method !== 'POST') return void response.writeHead(405).end()
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const replies = messages
        .map((m) =>
          handleMcpMessage(m, { env: { QA_MCP_TOKEN: 'http' }, headers: request.headers })
        )
        .filter(Boolean)
      if (replies.length === 0) return void response.writeHead(202).end()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]))
    })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
  }
}

const http = await startHttpMcp()

try {
  await runSuite(
    'ext-mcp',
    async ({ server, agentDir, app, step }) => {
      const { page } = app
      const { bugStep, finish } = bugSteps(step)
      const startLog = join(agentDir.dir, 'qa-mcp-starts.log')
      const starts = () =>
        existsSync(startLog) ? readFileSync(startLog, 'utf8').split('\n').filter(Boolean).length : 0
      const globalMcp = () => agentDir.readJson('mcp.json')
      let cwd
      const projectMcp = () => JSON.parse(readFileSync(join(cwd, '.pi', 'mcp.json'), 'utf8'))
      const serverRow = (name) => page.locator(`[id="setting-mcp.${name}"]`)
      const editor = page.getByRole('dialog', { name: /^(Add MCP server|Edit )/ })

      /** Call one tool through the fake LLM; returns the tool result the engine sent back. */
      const callTool = async (name, args, id) => {
        const from = server.requests.length
        server.queue(turn.toolCalls([{ id, name, args }]), turn.text(`Called ${name}.`))
        await app.send(`call ${name}`)
        await app.waitForSettle()
        const follow = await server.waitForRequest(
          (r) => inspectRequest(r).toolResults.some((t) => t.toolCallId === id),
          { from }
        )
        return inspectRequest(follow).toolResults.find((t) => t.toolCallId === id)
      }
      const restartEngines = async () => {
        await page
          .locator('[data-toaster]')
          .getByRole('button', { name: 'Restart engines' })
          .first()
          .click()
        await page.waitForTimeout(500)
        await app.test('waitForIdle', 60_000)
        await until(async () => (await app.agentState())?.status === 'ready', {
          timeoutMs: 60_000,
          label: 'engine ready'
        })
      }

      await step('project .pi/mcp.json asks for trust; trusting loads it', async () => {
        cwd = await app.createWorkspace({
          'README.md': '# MCP workspace\n',
          '.pi/mcp.json': {
            mcpServers: {
              'qa-proj': {
                command: 'node',
                args: [SERVER],
                env: { QA_MCP_TOKEN: 'tok-project', QA_MCP_LOG: startLog },
                exposure: 'direct'
              }
            }
          }
        })
        const opening = app.test('openWorkspace', cwd)
        const trust = page.getByRole('dialog', { name: /^Trust/ })
        await trust.waitFor()
        await trust.getByRole('option', { name: /Trust and remember/ }).click()
        await opening
        await page.getByRole('textbox', { name: 'Message' }).waitFor()
      })

      await step('Settings → MCP lists the project server under "This project"', async () => {
        await app.test('openSettings', 'mcp')
        await page.getByText('This project', { exact: true }).waitFor()
        await serverRow('qa-proj').waitFor()
      })

      await step(
        'Add server: stdio command, args, env, exposure, description → global mcp.json',
        async () => {
          await page.getByRole('button', { name: 'Add server' }).click()
          await editor.waitFor()
          await editor.getByPlaceholder('github', { exact: true }).fill('qa-mcp')
          await editor.getByPlaceholder('npx', { exact: true }).fill('node')
          // The placeholder disappears after the first argument; keep the element itself.
          const args = await editor
            .getByPlaceholder('-y, @modelcontextprotocol/server-github')
            .elementHandle()
          for (const arg of [SERVER, '--opt', 'a', '--opt', 'b']) {
            await args.fill(arg)
            await args.press('Enter')
          }
          await editor.getByText('Add variable', { exact: true }).click()
          await editor.getByRole('textbox', { name: 'Name' }).last().fill('QA_MCP_TOKEN')
          await editor.getByRole('textbox', { name: 'Value of QA_MCP_TOKEN' }).fill('tok-global')
          await editor.getByText('Add variable', { exact: true }).click()
          await editor.getByRole('textbox', { name: 'Name' }).last().fill('QA_MCP_LOG')
          await editor.getByRole('textbox', { name: 'Value of QA_MCP_LOG' }).fill(startLog)
          await editor.getByRole('combobox').first().click()
          await page.getByRole('option', { name: /^Direct/ }).click()
          await editor
            .getByPlaceholder('What the model should use it for')
            .fill('QA arithmetic server')
          await reportShot(app, 'ext-mcp-editor-add')
          await editor.getByRole('button', { name: 'Add server' }).click()
          await editor.waitFor({ state: 'detached' })
          const entry = (await globalMcp()).mcpServers['qa-mcp']
          assert.equal(entry.command, 'node')
          assert.equal(entry.args[0], SERVER)
          assert.deepEqual(entry.env, { QA_MCP_TOKEN: 'tok-global', QA_MCP_LOG: startLog })
          assert.equal(entry.exposure, 'direct')
          assert.equal(entry.description, 'QA arithmetic server')
        }
      )

      await bugStep('repeated arguments are kept in order', async () => {
        const entry = (await globalMcp()).mcpServers['qa-mcp']
        assert.deepEqual(entry.args, [SERVER, '--opt', 'a', '--opt', 'b'])
      })

      await step(
        'Test connections: both servers connected with 3 tools and resource support',
        async () => {
          await page.getByRole('button', { name: 'Test connections' }).click()
          await serverRow('qa-mcp').getByText('3 tools · resources').waitFor({ timeout: 90_000 })
          await serverRow('qa-proj').getByText('3 tools · resources').waitFor({ timeout: 30_000 })
          await reportShot(app, 'ext-mcp-settings-connected')
        }
      )

      await step(
        'restart: direct MCP tools and resource tools are declared to the model',
        async () => {
          await restartEngines()
          await app.test('closeSettings')
          const from = server.requests.length
          server.queue(turn.text('Tools listed.'))
          await app.send('list tools')
          await app.waitForSettle()
          const { tools } = inspectRequest(await server.waitForRequest(undefined, { from }))
          for (const name of ['mcp__qa_mcp__qa_add', 'mcp__qa_proj__qa_add', 'read_mcp_resource']) {
            assert.ok(tools.includes(name), `${name} declared (${tools.join(', ')})`)
          }
        }
      )

      await step('MCP tool call: result returned to the model and rendered', async () => {
        const result = await callTool('mcp__qa_mcp__qa_add', { a: 2, b: 3 }, 'toolu_mcp_add')
        assert.equal(result.text, 'sum=5')
        assert.equal(result.isError, false)
        // MCP tools get a friendly name: server + tool ("Qa mcp  Qa add").
        const row = page.locator('[data-tool-row]', { hasText: 'Qa add' }).first()
        await row.getByText('Qa mcp', { exact: true }).waitFor()
        await row.click()
        await page.getByText('sum=5', { exact: true }).first().waitFor()
        await reportShot(app, 'ext-mcp-tool-card')
      })

      await step('env reaches each server (global and project values)', async () => {
        assert.match(
          (await callTool('mcp__qa_mcp__qa_env', {}, 'toolu_mcp_env')).text,
          /token=tok-global/
        )
        assert.match(
          (await callTool('mcp__qa_proj__qa_env', {}, 'toolu_proj_env')).text,
          /token=tok-project/
        )
      })

      await step('resources: read_mcp_resource returns the text resource', async () => {
        const result = await callTool(
          'read_mcp_resource',
          { server: 'qa-mcp', uri: 'qa://notes/hello' },
          'toolu_mcp_res'
        )
        assert.match(result.text, /QA-MCP-RESOURCE-TEXT/)
      })

      await step(
        'an MCP isError result reaches the model as an error and renders as failed',
        async () => {
          const result = await callTool('mcp__qa_mcp__qa_fail', {}, 'toolu_mcp_fail')
          assert.equal(result.isError, true)
          assert.equal((await app.agentState()).tools.toolu_mcp_fail?.status, 'error')
        }
      )

      await step(
        '"Reconnect in open sessions" restarts the server in the running engine',
        async () => {
          const before = starts()
          await app.test('openSettings', 'mcp')
          await serverRow('qa-mcp').getByRole('button', { name: 'Server actions' }).click()
          await page.getByRole('menuitem', { name: 'Reconnect in open sessions' }).click()
          await page.locator('[data-toaster]').getByText('Reconnecting qa-mcp').waitFor()
          await until(() => starts() > before, { timeoutMs: 30_000, label: 'a new server process' })
        }
      )

      await step('edit: the change keeps env values; exposure select writes mcp.json', async () => {
        await serverRow('qa-mcp').getByRole('button', { name: 'qa-mcp' }).click()
        await editor.waitFor()
        await editor
          .getByPlaceholder('What the model should use it for')
          .fill('QA arithmetic server, edited')
        await editor.getByRole('button', { name: 'Save' }).click()
        await editor.waitFor({ state: 'detached' })
        let entry = (await globalMcp()).mcpServers['qa-mcp']
        assert.equal(entry.description, 'QA arithmetic server, edited')
        assert.equal(entry.env.QA_MCP_TOKEN, 'tok-global')
        await serverRow('qa-mcp').getByRole('combobox').click()
        await page.getByRole('option', { name: /^Code mode/ }).click()
        entry = await until(
          async () => {
            const e = (await globalMcp()).mcpServers['qa-mcp']
            return e.exposure === undefined ? e : null
          },
          { label: 'exposure back to the codemode default' }
        )
        assert.equal(entry.exposure, undefined)
      })

      await step(
        '"Disable in this project" writes a project override and badges the row',
        async () => {
          await serverRow('qa-mcp').getByRole('button', { name: 'Server actions' }).click()
          await page.getByRole('menuitem', { name: 'Disable in this project' }).click()
          await serverRow('qa-mcp').getByText('Off in this project').waitFor()
          assert.deepEqual(projectMcp().mcpServers['qa-mcp'], { enabled: false })
          await reportShot(app, 'ext-mcp-project-override')
        }
      )

      await step('HTTP server with an Authorization header from an env var', async () => {
        await page.getByRole('button', { name: 'Add server' }).click()
        await editor.waitFor()
        await editor.getByPlaceholder('github', { exact: true }).fill('qa-http')
        await editor.getByRole('radio', { name: 'HTTP' }).click()
        await editor.getByPlaceholder('https://mcp.example.com/mcp').fill(http.url)
        await editor.getByText('Add header', { exact: true }).click()
        await editor.getByRole('textbox', { name: 'Name' }).last().fill('Authorization')
        await editor
          .getByRole('textbox', { name: 'Value of Authorization' })
          .fill('Bearer ${QA_HTTP_TOKEN}')
        await editor.getByRole('combobox').first().click()
        await page.getByRole('option', { name: /^Direct/ }).click()
        await editor.getByRole('button', { name: 'Add server' }).click()
        await editor.waitFor({ state: 'detached' })
        assert.deepEqual((await globalMcp()).mcpServers['qa-http'].headers, {
          Authorization: 'Bearer ${QA_HTTP_TOKEN}'
        })
        await page.getByRole('button', { name: 'Test connections' }).click()
        await serverRow('qa-http').getByText('3 tools · resources').waitFor({ timeout: 60_000 })
        assert.ok(
          http.seen.some((r) => r.headers.authorization === `Bearer ${HTTP_TOKEN}`),
          'the header reached the server with the variable expanded'
        )
      })

      await step('a failing server shows its error in Settings', async () => {
        await page.getByRole('button', { name: 'Add server' }).click()
        await editor.waitFor()
        await editor.getByPlaceholder('github', { exact: true }).fill('qa-broken')
        await editor.getByPlaceholder('npx', { exact: true }).fill('node')
        // The placeholder disappears after the first argument; keep the element itself.
        const args = await editor
          .getByPlaceholder('-y, @modelcontextprotocol/server-github')
          .elementHandle()
        await args.fill(join(cwd, 'missing-server.mjs'))
        await args.press('Enter')
        await editor.getByRole('button', { name: 'Add server' }).click()
        await editor.waitFor({ state: 'detached' })
        await page.getByRole('button', { name: 'Test connections' }).click()
        const row = serverRow('qa-broken')
        await until(
          async () => {
            const text = await row.innerText()
            return !/Connecting|Unknown/.test(text) && text
          },
          { timeoutMs: 90_000, label: 'qa-broken status' }
        )
        await reportShot(app, 'ext-mcp-broken')
        const text = await row.innerText()
        assert.doesNotMatch(text, /tools/, `broken server is not shown as connected: ${text}`)
      })

      await bugStep('the failure reason is short and free of stack frames', async () => {
        const text = await serverRow('qa-broken').innerText()
        assert.doesNotMatch(text, /node:internal|EPIPE/, text)
      })

      await step('restart: the HTTP tool sees the header from the expanded env var', async () => {
        await restartEngines()
        await app.test('closeSettings')
        const result = await callTool('mcp__qa_http__qa_env', {}, 'toolu_http_env')
        assert.match(result.text, new RegExp(`authorization=Bearer ${HTTP_TOKEN}`))
        await reportShot(app, 'ext-mcp-after-restart')
      })

      await step(
        'the session warns that qa-broken needs attention (engine notify → toast)',
        async () => {
          await page
            .locator('[data-toaster]')
            .getByText(/MCP servers need attention:\s+qa-broken: failed/)
            .waitFor({ timeout: 30_000, state: 'attached' })
        }
      )

      await step('/mcp (no arguments) answers with a status toast over RPC', async () => {
        await submitComposer(app, '/mcp')
        const status = page
          .locator('[data-toaster]')
          .getByText(/qa-http/)
          .last()
        await status.waitFor({ timeout: 30_000 })
        await reportShot(app, 'ext-mcp-status-command')
      })

      await bugStep('a multi-line notify keeps its line breaks in the toast', async () => {
        const whiteSpace = await page
          .locator('[data-toaster]')
          .getByText(/qa-http: connected/)
          .last()
          .evaluate((element) => getComputedStyle(element).whiteSpace)
        assert.match(whiteSpace, /pre/, `toast white-space is ${whiteSpace}`)
      })

      await step('Remove deletes the server from mcp.json', async () => {
        await app.test('openSettings', 'mcp')
        await serverRow('qa-broken').getByRole('button', { name: 'Server actions' }).click()
        await page.getByRole('menuitem', { name: 'Remove' }).click()
        await until(async () => !(await globalMcp()).mcpServers['qa-broken'], {
          label: 'qa-broken removed'
        })
        await serverRow('qa-broken').waitFor({ state: 'detached' })
      })

      finish()
    },
    { launch: { env: { QA_HTTP_TOKEN: HTTP_TOKEN } } }
  )
} finally {
  await http.close()
}
