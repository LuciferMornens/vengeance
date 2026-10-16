// Extension tools, events and hooks through the real composer and the fake LLM: registerTool
// (exposure, generic rendering, failures), tool_call interception (block, confirm during a run),
// input transforms, the before_agent_start system prompt, lifecycle events, extension_error and
// the inspector's live tool toggles.
//
//   node scripts/qa/ext/extension-tools.qa.mjs
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  bugSteps,
  extLogLength,
  fixtureExtensionFiles,
  readExtLog,
  reportShot,
  submitComposer,
  until,
  waitForExtLog
} from './lib/ext-helpers.mjs'

await runSuite(
  'ext-extension-tools',
  async ({ server, agentDir, app, step }) => {
    const { page } = app
    const { bugStep, finish } = bugSteps(step)
    const dialog = (name) => page.getByRole('dialog', { name })
    /** Queue turns, send `text` through the composer, wait for the run to settle. */
    const run = async (text, ...turns) => {
      const from = server.requests.length
      server.queue(...turns)
      await app.send(text)
      await app.waitForSettle()
      return server.requests.slice(from)
    }

    await step('open: tools declared by exposure, hidden/codemode tools left out', async () => {
      await app.openWorkspace()
      const [request] = await run('hello fixture', turn.text('Hi from the fake model.'))
      const sent = inspectRequest(request)
      for (const name of ['qa_echo', 'qa_guarded', 'qa_boom', 'qa_fail']) {
        assert.ok(sent.tools.includes(name), `${name} declared (tools: ${sent.tools.join(', ')})`)
      }
      assert.ok(!sent.tools.includes('qa_hidden'), 'hidden exposure is never declared')
      assert.ok(!sent.tools.includes('qa_scripted'), 'codemode exposure is not declared')
    })

    await step('before_agent_start system prompt override reaches the model', async () => {
      const sent = inspectRequest(server.requests.at(-1))
      assert.match(sent.system, /QA-SYSTEM-MARKER mode=normal/)
    })

    await step(
      'lifecycle: input (rpc), before_agent_start, turn_end, agent_end in order',
      async () => {
        const kinds = readExtLog(agentDir).map((entry) => entry.kind)
        const order = ['input', 'before_agent_start', 'turn_end', 'agent_end'].map((kind) =>
          kinds.indexOf(kind)
        )
        assert.ok(
          order.every((index) => index >= 0),
          `all events logged: ${kinds.join(', ')}`
        )
        assert.deepEqual(
          [...order].sort((a, b) => a - b),
          order,
          'events fire in order'
        )
        assert.equal(readExtLog(agentDir).find((entry) => entry.kind === 'input').source, 'rpc')
      }
    )

    await step('input transform: the model receives the transformed text', async () => {
      const [request] = await run('qa-transform: make it so', turn.text('Transformed ok.'))
      assert.equal(inspectRequest(request).lastUserText, 'TRANSFORMED make it so')
      await page.getByText('Transformed ok.').waitFor()
      await reportShot(app, 'ext-tools-transform')
    })

    await step('input handled by the extension: no model call, composer idle', async () => {
      const from = server.requests.length
      await submitComposer(app, 'qa-handled')
      await page.locator('[data-toaster]').getByText('QA handled the input itself').waitFor()
      await app.waitForSettle()
      assert.equal(server.requests.length, from, 'no request for handled input')
    })

    await step('registered tool: called by the model, result returned, card rendered', async () => {
      const id = 'toolu_qa_echo'
      const requests = await run(
        'echo please',
        turn.toolCalls([{ id, name: 'qa_echo', args: { text: 'ping 42' } }]),
        turn.text('Echo done.')
      )
      const result = inspectRequest(requests.at(-1)).toolResults.find((r) => r.toolCallId === id)
      assert.equal(result.text, 'QA-ECHO: ping 42')
      assert.equal(result.isError, false)
      assert.equal((await app.agentState()).tools[id]?.status, 'done')
      const row = page.locator('[data-tool-row]', { hasText: 'ping 42' }).first()
      await row.waitFor()
      await reportShot(app, 'ext-tools-echo-card')
    })

    await step('tool_call block: the model gets the block reason as an error result', async () => {
      const id = 'toolu_qa_block'
      const requests = await run(
        'run the blocked command',
        turn.toolCalls([{ id, name: 'bash', args: { command: 'echo QA_BLOCK_ME' } }]),
        turn.text('It was blocked.')
      )
      const result = inspectRequest(requests.at(-1)).toolResults.find((r) => r.toolCallId === id)
      assert.equal(result.isError, true)
      assert.match(result.text, /Blocked by the QA fixture/)
      assert.equal((await app.agentState()).tools[id]?.status, 'error')
    })

    await step('confirm inside tool_call during a run: Yes lets the tool run', async () => {
      const id = 'toolu_qa_guard_yes'
      const from = extLogLength(agentDir)
      const requestsFrom = server.requests.length
      server.queue(turn.toolCalls([{ id, name: 'qa_guarded', args: {} }]), turn.text('Guard ok.'))
      await app.send('guarded yes')
      await dialog('QA allow the guarded tool?').waitFor()
      await reportShot(app, 'ext-tools-guard-dialog')
      await dialog('QA allow the guarded tool?').getByRole('button', { name: 'Yes' }).click()
      await app.waitForSettle()
      assert.equal((await waitForExtLog(agentDir, 'guard_answer', { from })).allowed, true)
      await waitForExtLog(agentDir, 'qa_guarded_ran', { from })
      const result = inspectRequest(server.requests.at(-1)).toolResults.find(
        (r) => r.toolCallId === id
      )
      assert.equal(result.text, 'QA-GUARDED-RAN')
      assert.equal(server.requests.length - requestsFrom, 2)
    })

    await step('confirm inside tool_call: No blocks the tool', async () => {
      const id = 'toolu_qa_guard_no'
      const from = extLogLength(agentDir)
      server.queue(turn.toolCalls([{ id, name: 'qa_guarded', args: {} }]), turn.text('Guard no.'))
      await app.send('guarded no')
      await dialog('QA allow the guarded tool?').waitFor()
      await dialog('QA allow the guarded tool?').getByRole('button', { name: 'No' }).click()
      await app.waitForSettle()
      assert.equal((await waitForExtLog(agentDir, 'guard_answer', { from })).allowed, false)
      const result = inspectRequest(server.requests.at(-1)).toolResults.find(
        (r) => r.toolCallId === id
      )
      assert.equal(result.isError, true)
      assert.match(result.text, /declined qa_guarded/)
    })

    await step('a tool that throws renders as a failed card', async () => {
      const id = 'toolu_qa_fail'
      const requests = await run(
        'fail please',
        turn.toolCalls([{ id, name: 'qa_fail', args: {} }]),
        turn.text('It failed.')
      )
      const result = inspectRequest(requests.at(-1)).toolResults.find((r) => r.toolCallId === id)
      assert.equal(result.isError, true)
      assert.match(result.text, /QA fixture tool failure/)
      assert.equal((await app.agentState()).tools[id]?.status, 'error')
      await page.getByText('QA fixture tool failure').first().waitFor()
    })

    await step(
      'a throwing tool_result handler shows as an extension error in the inspector',
      async () => {
        const id = 'toolu_qa_boom'
        await run(
          'boom please',
          turn.toolCalls([{ id, name: 'qa_boom', args: {} }]),
          turn.text('Boom handled.')
        )
        const errors = (await app.agentState()).extensionErrors
        const boom = errors.find((e) => /exploded/.test(e.error))
        assert.ok(boom, `extension_error recorded: ${JSON.stringify(errors)}`)
        assert.equal(boom.event, 'tool_result')
        await page.keyboard.press('Control+i')
        await page.locator('[data-tab="extensions"]').click()
        // The inspector's list (the error's toast quotes it too).
        await page
          .getByRole('tabpanel', { name: 'Extensions' })
          .getByText('QA fixture tool_result handler exploded')
          .waitFor()
        await reportShot(app, 'ext-tools-inspector-extensions')
      }
    )

    await step('inspector Tools tab lists the fixture tools with their exposure', async () => {
      await page.locator('[data-tab="tools"]').click()
      await page.getByText('qa_echo', { exact: true }).waitFor()
      await page.getByText('qa_scripted', { exact: true }).waitFor()
      await reportShot(app, 'ext-tools-inspector-tools')
    })

    await step('turning a tool off in the inspector removes it from the next request', async () => {
      await page.getByRole('switch', { name: /qa_echo/ }).click()
      const [request] = await run('without echo', turn.text('No echo.'))
      assert.ok(!inspectRequest(request).tools.includes('qa_echo'), 'qa_echo no longer declared')
      await page.getByRole('switch', { name: /qa_echo/ }).click()
      const [again] = await run('with echo', turn.text('Echo back.'))
      assert.ok(inspectRequest(again).tools.includes('qa_echo'), 'qa_echo declared again')
      await page.keyboard.press('Control+i')
    })

    await bugStep(
      'aborting a run drops the dialog its tool_call guard was waiting on',
      async () => {
        const from = extLogLength(agentDir)
        server.queue(
          turn.toolCalls([{ id: 'toolu_qa_guard_abort', name: 'qa_guarded', args: {} }]),
          turn.text('after abort')
        )
        await app.send('guarded abort')
        await dialog('QA allow the guarded tool?').waitFor()
        await app.rpc({ type: 'abort' })
        assert.equal((await waitForExtLog(agentDir, 'guard_answer', { from })).allowed, false)
        await app.waitForSettle()
        await reportShot(app, 'ext-tools-stale-dialog')
        await until(async () => (await app.agentState()).ext.dialogs.length === 0, {
          timeoutMs: 3000,
          label: 'the dead dialog to close'
        })
      }
    )
    finish()
  },
  { agentDir: { files: fixtureExtensionFiles() } }
)
