// Chat: OpenAI native compaction on the real Engine against the fake LLM's Responses route.
// The `openai` provider's gpt-6-luna / gpt-6-sol point at the fake server:
//   - /compact sends the Engine's summary request and one native compaction_trigger request;
//   - the item lands in a `vengeance-native-compaction` entry for that compaction;
//   - the next turn on that model sends the compaction item instead of the summary message;
//   - another openai model, and a non-OpenAI model, get the summary;
//   - a second compaction carries the previous item into its native request;
//   - Settings → Agent behavior → OpenAI native compaction off: new sessions only summarize.
import assert from 'node:assert/strict'
import { FAKE_API_KEY, FAKE_MODELS, FAKE_PROVIDER, defaultFakeModels } from '../lib/agent-dir.mjs'
import { API, inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { closeSettings, openSettings, settingRow } from '../settings/settings-ui.mjs'
import { sendAndCapture, softSteps, submitCommand, until } from './helpers.mjs'

const LUNA = 'openai/gpt-6-luna'
const SOL = 'openai/gpt-6-sol'
const ENTRY = 'vengeance-native-compaction'

const isNativeRequest = (request) => request.body?.input?.at(-1)?.type === 'compaction_trigger'
const isSummaryRequest = (request) => {
  const text = inspectRequest(request).lastUserText
  return (
    text.includes('<conversation>') || text.includes('earlier context from an ongoing conversation')
  )
}
const summaryText = (request) =>
  inspectRequest(request).messages.find((m) => m.role === 'user')?.text ?? ''
const compactionItems = (request) =>
  inspectRequest(request).messages.filter((m) => m.role === 'compaction')

function openaiModel(server, id, name) {
  return {
    id,
    name,
    api: API.responses,
    baseUrl: server.openaiBaseUrl,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 272_000,
    maxTokens: 128_000,
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 }
  }
}

async function nativeEntries(app) {
  const { entries } = await app.rpc({ type: 'get_entries' })
  const compactions = entries.filter((e) => e.type === 'compaction')
  return {
    compactions,
    natives: entries.filter((e) => e.type === 'custom' && e.customType === ENTRY)
  }
}

/** One /compact: summary and native requests answered; returns both requests. */
async function compactNow(app, server, label, instructions = '') {
  const from = server.requests.length
  server.queue(
    turn.text(`## Goal\n${label}`, { when: isSummaryRequest }),
    turn.text(`${label} (turn prefix)`, { when: isSummaryRequest }),
    turn.text('', { when: isNativeRequest })
  )
  await submitCommand(app, `/compact${instructions ? ` ${instructions}` : ''}`)
  const summary = await server.waitForRequest(isSummaryRequest, { from })
  const native = await server.waitForRequest(isNativeRequest, { from })
  await app.page.getByText('Context compacted', { exact: true }).first().waitFor()
  await app.waitForSettle()
  server.reset()
  return { summary, native }
}

await runSuite(
  'chat-native-compaction',
  async ({ server, agentDir, app, step }) => {
    const checks = softSteps(step, app)
    await agentDir.writeText('models.json', {
      providers: {
        [FAKE_PROVIDER]: {
          name: 'QA Fake',
          baseUrl: server.anthropicBaseUrl,
          api: API.anthropic,
          apiKey: FAKE_API_KEY,
          models: defaultFakeModels(server)
        },
        openai: {
          apiKey: FAKE_API_KEY,
          models: [
            openaiModel(server, 'gpt-6-luna', 'GPT-6 Luna'),
            openaiModel(server, 'gpt-6-sol', 'GPT-6 Sol')
          ]
        }
      }
    })

    await step('open on openai/gpt-6-luna; two turns', async () => {
      await app.openWorkspace({ args: { model: LUNA } })
      for (const n of [1, 2]) {
        server.queue(turn.text(`Answer ${n} with enough words to be worth compacting later on.`))
        const { request } = await sendAndCapture(app, server, `Question ${n}`)
        assert.equal(
          request.api,
          API.responses,
          'the openai model talks to the fake Responses route'
        )
        assert.equal(isNativeRequest(request), false, 'a normal turn has no context_management')
      }
    })

    await step('/compact: the summary request and one native request, in parallel', async () => {
      const { summary, native } = await compactNow(app, server, 'SUMMARY-ONE', 'Keep the numbers')
      assert.equal(isNativeRequest(summary), false, 'the summary request is a plain request')
      assert.deepEqual(native.body.input.at(-1), { type: 'compaction_trigger' })
      assert.equal(native.body.context_management, undefined)
      assert.equal(native.body.max_output_tokens, undefined)
      assert.ok(native.body.tools.length > 0, 'the actual tool schemas are preserved')
      assert.equal(native.body.model, 'gpt-6-luna')
      const sent = inspectRequest(native)
      assert.match(
        sent.messages.map((m) => m.text).join('\n'),
        /Question 1/,
        'the native request carries the history'
      )
      assert.doesNotMatch(
        sent.lastUserText,
        /Checkpoint:|Reply with OK/,
        'no synthetic user instruction'
      )
      assert.match(
        inspectRequest(summary).lastUserText,
        /Keep the numbers/,
        'custom instructions guide the portable summary'
      )
      const { compactions, natives } = await nativeEntries(app)
      assert.equal(compactions.length, 1)
      assert.equal(natives.length, 1, 'one native entry')
      assert.equal(natives[0].data.compactionId, compactions[0].id, 'tied to the compaction')
      assert.equal(natives[0].data.model, 'gpt-6-luna')
      assert.equal(natives[0].data.format, 'responses-compaction-trigger-v1')
      assert.match(natives[0].data.item.encrypted_content, /^qa-compaction-/)
    })

    await step(
      'next turn on gpt-6-luna: the compaction item replaces the summary message',
      async () => {
        server.queue(turn.text('Continuing natively.'))
        const { request } = await sendAndCapture(app, server, 'Question 3')
        const items = compactionItems(request)
        assert.equal(items.length, 1, 'one compaction item in the input')
        assert.match(items[0].encrypted, /^qa-compaction-/)
        assert.doesNotMatch(summaryText(request), /SUMMARY-ONE/, 'no summary text sent')
        assert.equal(
          isNativeRequest(request),
          false,
          'normal turns stay without context_management'
        )
        assert.match(inspectRequest(request).lastUserText, /Question 3/)
      }
    )

    await checks.check(
      'another OpenAI model (gpt-6-sol) gets the summary, not the item',
      async () => {
        await app.rpc({ type: 'set_model', provider: 'openai', modelId: 'gpt-6-sol' })
        server.queue(turn.text('Sol answer.'))
        const { request } = await sendAndCapture(app, server, 'Question 4')
        assert.equal(compactionItems(request).length, 0)
        assert.match(summaryText(request), /SUMMARY-ONE/)
        await app.rpc({ type: 'set_model', provider: 'openai', modelId: 'gpt-6-luna' })
      }
    )

    await checks.check(
      'a non-OpenAI model gets the summary and compacts without a native request',
      async () => {
        await app.rpc({
          type: 'set_model',
          provider: FAKE_PROVIDER,
          modelId: FAKE_MODELS.reasoning
        })
        server.queue(turn.text('Claude-like answer.'))
        const { request } = await sendAndCapture(app, server, 'Question 5')
        assert.equal(request.api, API.anthropic)
        assert.match(summaryText(request), /SUMMARY-ONE/)
        const from = server.requests.length
        server.queue(
          turn.text('## Goal\nSUMMARY-QA', { when: isSummaryRequest }),
          turn.text('prefix', { when: isSummaryRequest })
        )
        await submitCommand(app, '/compact')
        await server.waitForRequest(isSummaryRequest, { from })
        await app.waitForSettle()
        await new Promise((resolve) => setTimeout(resolve, 500))
        assert.equal(
          server.requests.slice(from).filter(isNativeRequest).length,
          0,
          'no native request for a non-OpenAI model'
        )
        server.reset()
        await app.rpc({ type: 'set_model', provider: 'openai', modelId: 'gpt-6-luna' })
      }
    )

    await checks.check(
      'a second compaction on gpt-6-luna replays the previous native item in its native request',
      async () => {
        // Compact natively once more (the QA compaction above has no native item), then again.
        server.queue(turn.text('Luna again.'))
        await sendAndCapture(app, server, 'Question 6')
        await compactNow(app, server, 'SUMMARY-TWO')
        server.queue(turn.text('Luna after two.'))
        await sendAndCapture(app, server, 'Question 7')
        const { native } = await compactNow(app, server, 'SUMMARY-THREE')
        const items = compactionItems(native)
        assert.equal(items.length, 1, 'the previous item stands in for the previous summary')
        assert.doesNotMatch(summaryText(native), /SUMMARY-TWO/)
        const { natives, compactions } = await nativeEntries(app)
        assert.equal(natives.at(-1).data.compactionId, compactions.at(-1).id)
      }
    )

    await checks.check(
      'Settings → Agent behavior shows the switch; off → a new session only summarizes',
      async () => {
        await openSettings(app, 'Agent behavior')
        const row = settingRow(app, 'app.nativeCompaction')
        await row.scrollIntoViewIfNeeded()
        await app.screenshot('native-compaction-setting')
        await row.getByRole('switch', { name: 'OpenAI native compaction' }).click()
        await until(
          async () => (await app.appState()).prefs.features.settings?.nativeCompaction === false,
          { label: 'pref saved' }
        )
        await closeSettings(app)
        await app.openWorkspace({ args: { model: LUNA } })
        server.queue(turn.text('Fresh session answer with some words.'))
        await sendAndCapture(app, server, 'Fresh question')
        const from = server.requests.length
        server.queue(
          turn.text('## Goal\nSUMMARY-OFF', { when: isSummaryRequest }),
          turn.text('prefix', { when: isSummaryRequest })
        )
        await submitCommand(app, '/compact')
        await server.waitForRequest(isSummaryRequest, { from })
        await app.waitForSettle()
        await new Promise((resolve) => setTimeout(resolve, 500))
        assert.equal(
          server.requests.slice(from).filter(isNativeRequest).length,
          0,
          'switched off: no native request'
        )
        server.reset()
      }
    )

    checks.assertAll()
  },
  { agentDir: { settings: { compaction: { keepRecentTokens: 1 }, retry: { baseDelayMs: 100 } } } }
)
