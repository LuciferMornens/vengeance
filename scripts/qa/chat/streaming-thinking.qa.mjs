// Chat: streaming text + markdown, thinking blocks, every thinking level from the footer picker
// (anthropic budget and openai reasoning_effort), and the engine's per-model thinking level.
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  THINKING_BUDGETS,
  assertCleanUiText,
  bodyText,
  pickModelInFooter,
  pickThinkingLevel,
  sendAndCapture,
  until
} from './helpers.mjs'

const MARKDOWN = [
  '## Streaming heading',
  '',
  'Some **bold words** and `inline code` with a [link](https://example.com).',
  '',
  '- first bullet',
  '- second bullet',
  '',
  '| col a | col b |',
  '| ----- | ----- |',
  '| 1     | 2     |',
  '',
  '```js',
  'const answer = 42',
  '```',
  '',
  'Final paragraph after the code.'
].join('\n')

await runSuite(
  'chat-streaming-thinking',
  async ({ server, app, agentDir, step }) => {
    await step('open on qa-reasoning, thinking off', async () => {
      await app.openWorkspace({
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, thinking: 'off' }
      })
      assert.equal((await app.agentState()).thinkingLevel, 'off')
    })

    await step('markdown streams progressively, then renders as markdown', async () => {
      server.queue(turn.text(MARKDOWN, { chunkSize: 6, delayMs: 25 }))
      await app.send('Show me markdown')
      // While streaming: the live markdown node grows over several observations.
      const lengths = []
      await until(
        async () => {
          const length = await app.page.evaluate(
            () => document.querySelector('.md-live')?.textContent?.length ?? -1
          )
          if (length > 0 && length !== lengths.at(-1)) lengths.push(length)
          return lengths.length >= 3
        },
        { label: 'three growing live-markdown snapshots', intervalMs: 30 }
      )
      await app.waitForSettle()
      assert.ok(lengths[0] < lengths[2], `text grew while streaming: ${lengths.join(' → ')}`)
      const md = app.page.locator('.md').last()
      await md.locator('h2', { hasText: 'Streaming heading' }).waitFor()
      await md.locator('strong', { hasText: 'bold words' }).waitFor()
      await md.locator('li', { hasText: 'second bullet' }).waitFor()
      await md.locator('table').waitFor()
      await md.locator('a', { hasText: 'link' }).waitFor()
      assert.ok(await md.getByText('const answer = 42').isVisible(), 'code block shows the code')
      assert.equal(await app.page.locator('.md-live').count(), 0, 'no live node after settle')
      const text = await md.innerText()
      assert.doesNotMatch(text, /```|\*\*bold|\| ----- \|/, 'no raw markdown syntax left')
      await app.screenshot('streaming-markdown')
    })

    await step('thinking turn: live "Thinking…" chip, then expandable "Thought for"', async () => {
      await pickThinkingLevel(app, 'low')
      server.queue(
        turn.thinking('Considering the question step by step. '.repeat(6), 'Here is my answer.', {
          chunkSize: 8,
          delayMs: 20
        })
      )
      await app.send('Think about it')
      await app.page.getByText('Thinking…').first().waitFor({ timeout: 10_000 })
      await app.waitForSettle()
      const chip = app.page.getByRole('button', { name: /^Thought/ }).last()
      await chip.waitFor()
      assert.equal(await chip.getAttribute('aria-expanded'), 'false')
      await chip.click()
      await app.page.getByText('Considering the question step by step.').first().waitFor()
      assert.equal(await chip.getAttribute('aria-expanded'), 'true')
      await app.screenshot('thinking-expanded')
    })

    await step('anthropic: every footer level sends its thinking budget', async () => {
      const levels = (await app.agentState()).thinkingLevels
      assert.deepEqual(levels, ['off', 'minimal', 'low', 'medium', 'high'])
      for (const level of levels) {
        await pickThinkingLevel(app, level)
        const engine = await app.rpc({ type: 'get_state' })
        assert.equal(engine.thinkingLevel, level, `engine level after picking ${level}`)
        const { sent } = await sendAndCapture(app, server, `level ${level}`)
        if (level === 'off') assert.deepEqual(sent.thinking, { type: 'disabled' })
        else {
          assert.equal(sent.thinking?.type, 'enabled', `${level}: thinking enabled`)
          assert.equal(sent.thinking?.budget_tokens, THINKING_BUDGETS[level], `${level} budget`)
          assert.ok(sent.maxTokens > sent.thinking.budget_tokens, `${level}: max_tokens > budget`)
        }
        const pill = await app.page.getByRole('button', { name: /^Thinking level:/ }).innerText()
        assert.match(pill, new RegExp(level, 'i'), `pill shows ${level}`)
      }
    })

    await step('Shift+Tab in the composer cycles the level and the request follows', async () => {
      await pickThinkingLevel(app, 'off')
      await app.page.getByRole('textbox', { name: 'Message' }).press('Shift+Tab')
      await until(async () => (await app.agentState()).thinkingLevel === 'minimal', {
        label: 'Shift+Tab → minimal'
      })
      const { sent } = await sendAndCapture(app, server, 'after shift tab')
      assert.equal(sent.thinking?.budget_tokens, THINKING_BUDGETS.minimal)
    })

    await step('openai: every footer level sends reasoning_effort', async () => {
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.openai)
      const levels = (await app.agentState()).thinkingLevels
      assert.deepEqual(levels, ['off', 'minimal', 'low', 'medium', 'high'])
      for (const level of levels) {
        await pickThinkingLevel(app, level)
        server.queue(turn.thinking(`reasoning at ${level}`, `answer at ${level}`))
        const { sent, request } = await sendAndCapture(app, server, `openai ${level}`)
        assert.equal(sent.api, 'openai-completions')
        assert.equal(sent.model, FAKE_MODELS.openai)
        if (level === 'off') assert.equal(request.body.reasoning_effort, undefined)
        else assert.equal(sent.reasoningEffort, level, `${level}: reasoning_effort`)
        await app.page.getByText(`answer at ${level}`).waitFor()
      }
      // openai reasoning_content renders as a thinking block too.
      await app.page
        .getByRole('button', { name: /^Thought/ })
        .last()
        .click()
      await app.page.getByText('reasoning at high').waitFor()
    })

    await step('per-model level: modelThinkingLevels applies on a model switch', async () => {
      // The engine only reads modelThinkingLevels (settings.md); it never writes it on its own.
      const before = await agentDir.readJson('settings.json')
      assert.equal(before.modelThinkingLevels, undefined)
      await pickThinkingLevel(app, 'medium')
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.reasoning)
      // No per-model entry: the engine keeps the default (defaultThinkingLevel unset → current).
      const levelAfter = (await app.agentState()).thinkingLevel
      const engine = await app.rpc({ type: 'get_state' })
      assert.equal(levelAfter, engine.thinkingLevel, 'pill matches engine after switch')
      const { sent } = await sendAndCapture(app, server, 'after switch back')
      if (engine.thinkingLevel === 'off') assert.deepEqual(sent.thinking, { type: 'disabled' })
      else assert.equal(sent.thinking?.budget_tokens, THINKING_BUDGETS[engine.thinkingLevel])
    })

    await step('UI copy: no "pi", no raw JSON', async () => {
      assertCleanUiText(await bodyText(app))
      app.assertNoErrors()
    })
  },
  { launch: { outDir: SHOTS_DIR } }
)

await runSuite(
  'chat-per-model-thinking',
  async ({ server, app, step }) => {
    await step('open qa-reasoning (per-model level: high)', async () => {
      await app.openWorkspace({ args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}` } })
      const state = await app.agentState()
      assert.equal(state.thinkingLevel, 'high', 'modelThinkingLevels["qa/qa-reasoning"] at startup')
    })

    await step('switch to qa-openai through the footer → its per-model level (low)', async () => {
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.openai)
      assert.equal((await app.agentState()).thinkingLevel, 'low')
      const pill = await app.page.getByRole('button', { name: /^Thinking level:/ }).innerText()
      assert.match(pill, /low/i)
      const { sent } = await sendAndCapture(app, server, 'per model openai')
      assert.equal(sent.reasoningEffort, 'low')
    })

    await step('switch back → high again, request carries the high budget', async () => {
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.reasoning)
      assert.equal((await app.agentState()).thinkingLevel, 'high')
      const { sent } = await sendAndCapture(app, server, 'per model anthropic')
      assert.equal(sent.thinking?.budget_tokens, THINKING_BUDGETS.high)
      const request = server.requests.at(-1)
      assert.equal(inspectRequest(request).model, FAKE_MODELS.reasoning)
    })
  },
  {
    launch: { outDir: SHOTS_DIR },
    agentDir: {
      settings: {
        modelThinkingLevels: {
          [`${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`]: 'high',
          [`${FAKE_PROVIDER}/${FAKE_MODELS.openai}`]: 'low'
        }
      }
    }
  }
)
