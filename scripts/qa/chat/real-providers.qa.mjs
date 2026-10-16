// Chat, REAL mode (the user's own engine config, guarded): prove the OAuth providers work inside
// Vengeance. Two tiny model calls, --no-session, temp workspace: 1. the default model (anthropic),
// 2. an openai-codex model picked in the footer, after a thinking-level change in the footer.
// Nothing from auth.json is read or printed; close() checks the real config did not change.
import assert from 'node:assert/strict'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  pickModelInFooter,
  pickThinkingLevel,
  transcriptText,
  until
} from './helpers.mjs'

const PROMPT = 'Reply with exactly: ok'
const REAL_SETTLE_MS = 180_000

/** Send the tiny prompt through the composer; the reply is checked from the engine's messages. */
async function tinyTurn(app) {
  await app.send(PROMPT)
  await app.waitForSettle({ timeoutMs: REAL_SETTLE_MS })
  const { messages } = await app.rpc({ type: 'get_messages' })
  const reply = messages.filter((m) => m.role === 'assistant').at(-1)
  assert.ok(reply, 'an assistant reply')
  const text = reply.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return { reply, text }
}

function describeReply({ reply, text }) {
  return (
    `${reply.provider}/${reply.model} stop=${reply.stopReason} text=${JSON.stringify(text.slice(0, 40))}` +
    ` usage=${reply.usage?.input ?? '?'}in/${reply.usage?.output ?? '?'}out` +
    (reply.errorMessage ? ` error=${JSON.stringify(reply.errorMessage.slice(0, 160))}` : '')
  )
}

await runSuite(
  'chat-real-providers',
  async ({ app, step }) => {
    await step('open a temp workspace on the default model (--no-session)', async () => {
      await app.openWorkspace()
      const state = await app.agentState()
      console.log(
        `    default model: ${state.model?.provider}/${state.model?.id}, thinking ${state.thinkingLevel}`
      )
      assert.ok(!state.session?.sessionFile, 'no session file in REAL mode')
    })

    await step('real call 1: the default anthropic model answers', async () => {
      const state = await app.agentState()
      assert.equal(state.model?.provider, 'anthropic', 'default provider is anthropic')
      const result = await tinyTurn(app)
      console.log(`    ${describeReply(result)}`)
      assert.equal(result.reply.stopReason, 'stop', describeReply(result))
      assert.match(result.text, /\bok\b/i)
      assert.ok(result.reply.usage.output > 0, 'usage reported')
      await app.screenshot('real-anthropic')
    })

    await step(
      'real call 2: openai-codex model + thinking level, both picked in the footer',
      async () => {
        const { models } = await app.rpc({ type: 'get_available_models' })
        const codexModels = models.filter((model) => model.provider === 'openai-codex')
        console.log(
          `    openai-codex models: ${codexModels.map((model) => model.id).join(', ') || 'none'}`
        )
        assert.ok(codexModels.length > 0, 'the user has openai-codex models')
        // gpt-5.3-codex-spark is listed but refused for ChatGPT accounts ("not supported when using
        // Codex with a ChatGPT account"), so prefer the mainstream model.
        const codex =
          codexModels.find((model) => model.id === 'gpt-5.5') ??
          codexModels.find((model) => !/spark/i.test(model.id))
        await pickModelInFooter(app, 'openai-codex', codex.id)
        const { levels } = await app.rpc({ type: 'get_available_thinking_levels' })
        const current = (await app.agentState()).thinkingLevel
        const target = ['low', 'minimal', 'medium', 'high'].find(
          (level) => levels.includes(level) && level !== current
        )
        assert.ok(target, `a different level (levels: ${levels.join(', ')}, current ${current})`)
        await pickThinkingLevel(app, target)
        assert.equal((await app.rpc({ type: 'get_state' })).thinkingLevel, target)
        const result = await tinyTurn(app)
        console.log(`    thinking ${current} → ${target}: ${describeReply(result)}`)
        assert.equal(result.reply.provider, 'openai-codex')
        assert.equal(result.reply.model, codex.id)
        assert.equal(result.reply.stopReason, 'stop', describeReply(result))
        assert.match(result.text, /\bok\b/i)
        await until(async () => /ok/i.test(await transcriptText(app)), { label: 'reply rendered' })
        await app.screenshot('real-openai-codex-thinking')
        app.assertNoErrors()
      }
    )
  },
  { mode: 'real', launch: { outDir: SHOTS_DIR } }
)
