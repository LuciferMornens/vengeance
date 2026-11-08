import { strict as assert } from 'node:assert'
import { PrimeEventAdapter } from '../../src/main/engine/prime/events'
import type { PrimeRecord } from '../../src/main/engine/prime/transport'
import { imageTurnRefusal } from '../../src/renderer/features/chat/provider-error'
import {
  imageNotice,
  matchModelReference,
  type ImageNoticeInputs
} from '../../src/renderer/features/composer/image-support'
import { reduceAgentEvent } from '../../src/renderer/store/agent-reducer'
import { createAgentState, type AgentState } from '../../src/renderer/store/agent-state'
import type { Model } from '../../src/shared/engine-types'
import { check } from './harness'

// Engine 2 0.10.2's texts (pa-core `image_model_routing.rs`), as its daemon sends them.
const REFUSAL =
  'This turn attaches images, but the selected model (groq/llama-3.1-8b-instant) does not accept image input.\n\nPick one:\n- Switch the session model to an image-capable one with /model, or\n- Set imageModel in settings.json to an image-capable model ("provider/model-id" or a bare id), e.g. "anthropic/claude-sonnet-4-5"\n\nThen resend the message. Without it the request would silently drop the images.'
const UNUSABLE =
  'imageModel "openai/gpt-4o" could not be resolved to an available, image-capable, authenticated model.\n\nFix the imageModel setting (settings.json) or authenticate the provider, then resend the message.'
const IMAGE = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }

function session(): { adapter: PrimeEventAdapter; state: () => AgentState } {
  let state = createAgentState({
    agentId: 'prime-turn-failure',
    engine: 'prime',
    cwd: process.cwd(),
    status: 'ready',
    mock: true,
    busy: false,
    bridge: false,
    createdAt: Date.now(),
    args: { engine: 'prime', cwd: process.cwd() }
  })
  const adapter = new PrimeEventAdapter((event) => {
    state = reduceAgentEvent(state, event)
  })
  return { adapter, state: () => state }
}

/** The daemon's frames for a turn it ends before the agent loop runs: the accepted row, then its settle. */
function refusedTurn(adapter: PrimeEventAdapter, settle: PrimeRecord): void {
  const message = { role: 'user', content: [{ type: 'text', text: 'What is this?' }, IMAGE] }
  adapter.accept({ type: 'message_start', message })
  adapter.accept({ type: 'message_end', message })
  adapter.accept(settle)
}

function model(id: string, name: string, image: boolean, provider = 'groq'): Model {
  return {
    id,
    name,
    api: 'openai-completions',
    provider,
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: image ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 8_192
  }
}

const TEXT_ONLY = model('llama-3.1-8b-instant', 'Llama 3.1 8B Instant', false)
const VISION = model('gpt-4o', 'GPT-4o', true, 'openai')

await check('Engine 2 reports an image turn its model cannot read as the turn’s failure', () => {
  const { adapter, state } = session()
  refusedTurn(adapter, { type: 'turn_end', error: REFUSAL })
  assert.equal(state().phase, 'idle', 'the agent loop never started')
  assert.equal(state().entries.length, 1, 'the refused message stays in the transcript')
  assert.deepEqual(state().turnError, { message: REFUSAL, entries: 1 })
})

await check('Engine 2 turn failures leave stops and completed turns alone', () => {
  const stopped = session()
  refusedTurn(stopped.adapter, { type: 'turn_end', error: 'No response produced.' })
  assert.equal(stopped.state().turnError, undefined, 'a stopped turn is not a failure')

  const completed = session()
  refusedTurn(completed.adapter, { type: 'turn_end' })
  assert.equal(completed.state().turnError, undefined)

  // A turn the loop ran reports its failure on the assistant message, never on the settle frame.
  const ran = session()
  refusedTurn(ran.adapter, {
    type: 'turn_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '500' },
    toolResults: []
  })
  assert.equal(ran.state().turnError, undefined)
})

await check('Engine 2 clears a turn failure when the next run starts', () => {
  const { adapter, state } = session()
  refusedTurn(adapter, { type: 'turn_end', error: REFUSAL })
  adapter.accept({ type: 'agent_start' })
  assert.equal(state().turnError, undefined)
})

await check('Engine 2 image refusals are recognized for the app’s own wording', () => {
  assert.deepEqual(imageTurnRefusal(REFUSAL), {
    kind: 'required',
    model: 'groq/llama-3.1-8b-instant'
  })
  assert.deepEqual(imageTurnRefusal(UNUSABLE), { kind: 'unusable', reference: 'openai/gpt-4o' })
  assert.equal(imageTurnRefusal('No API key found for groq.'), undefined)
})

await check('Image model references resolve like Engine 2 resolves them', () => {
  const routed = model('openai/gpt-5.5', 'GPT-5.5 (OpenRouter)', true, 'openrouter')
  const twin = model('gpt-4o', 'GPT-4o (Azure)', true, 'azure')
  const models = [TEXT_ONLY, VISION, routed]
  assert.equal(matchModelReference('OpenAI/GPT-4o', models), VISION)
  assert.equal(matchModelReference(' gpt-4o ', models), VISION)
  assert.equal(matchModelReference('openrouter/openai/gpt-5.5', models), routed)
  assert.equal(matchModelReference('gpt-4o', [...models, twin]), undefined, 'ambiguous bare id')
  assert.equal(matchModelReference('anthropic/claude-sonnet-4-5', models), undefined)
  assert.equal(matchModelReference('  ', models), undefined)
})

await check('The composer says what each engine does with images a model cannot read', () => {
  const inputs = (patch: Partial<ImageNoticeInputs>): ImageNoticeInputs => ({
    engine: 'prime',
    model: TEXT_ONLY,
    blockImages: false,
    ...patch
  })
  const ignored = {
    tone: 'warning',
    text: 'Llama 3.1 8B Instant can’t read images. They will be ignored.'
  }
  assert.deepEqual(imageNotice(inputs({ engine: 'pi' })), ignored)
  assert.deepEqual(imageNotice(inputs({ blockImages: true })), ignored)
  assert.equal(imageNotice(inputs({ model: VISION })), undefined)
  assert.deepEqual(imageNotice(inputs({ model: { ...TEXT_ONLY, input: [] } })), {
    tone: 'warning',
    text: 'Image support could not be verified for Llama 3.1 8B Instant.'
  })

  assert.deepEqual(imageNotice(inputs({})), {
    tone: 'danger',
    text: 'Llama 3.1 8B Instant can’t read images, so Engine 2 will refuse this message.',
    refusal: 'unset'
  })

  assert.equal(imageNotice(inputs({ imageModel: 'openai/gpt-4o' })), undefined, 'models loading')
  assert.deepEqual(imageNotice(inputs({ imageModel: 'openai/gpt-4o', available: [VISION] })), {
    tone: 'info',
    text: 'Llama 3.1 8B Instant can’t read images, so GPT-4o will answer this message.'
  })
  for (const available of [[], [TEXT_ONLY]]) {
    const unusable = imageNotice(inputs({ imageModel: TEXT_ONLY.id, available }))
    assert.equal(unusable?.tone, 'danger')
    assert.equal(unusable?.refusal, 'unusable')
    assert.match(unusable!.text, /its image model “llama-3\.1-8b-instant” isn’t a signed-in model/)
  }
})
