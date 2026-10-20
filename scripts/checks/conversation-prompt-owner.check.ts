import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentInfo,
  ConversationPrompt,
  CreateAgentArgs,
  EngineId
} from '../../src/shared/api/engine'
import {
  appliedPrompt,
  assertInPlaceSwitch,
  carriedPrompt,
  ConversationPromptOwners,
  piSessionReplacement,
  primeSessionReplacement,
  savedSessionFile,
  unwrittenPrompt,
  withConversationPrompt,
  type SavedPrompts
} from '../../src/main/engine/conversation-prompt-owner'
import { conversationPromptKey } from '../../src/main/features/sessions/conversation-prompts'
import { check } from './harness'

const CWD = join(tmpdir(), 'vengeance-owner-project')
const A = join(CWD, 'sessions', 'a.jsonl')
const B = join(CWD, 'sessions', 'b.jsonl')
const F = join(CWD, 'sessions', 'fork.jsonl')

const P: ConversationPrompt = { mode: 'append', text: 'Answer in French.', updatedAt: 1 }
const Q: ConversationPrompt = { mode: 'replace', text: 'You review payment code.', updatedAt: 2 }

/** Saved instructions, keyed like the store. */
function saved(entries: Array<[EngineId, string, ConversationPrompt]>): SavedPrompts {
  const prompts = new Map(
    entries.map(([engine, file, prompt]) => [conversationPromptKey(engine, file), prompt])
  )
  return { get: (engine, file) => prompts.get(conversationPromptKey(engine, file)) }
}

function agent(
  args: Partial<CreateAgentArgs>,
  info: Partial<Omit<AgentInfo, 'args'>> = {}
): AgentInfo {
  const engine = info.engine ?? args.engine ?? 'pi'
  return {
    agentId: 'agent-1',
    engine,
    cwd: CWD,
    status: 'ready',
    mock: false,
    busy: false,
    bridge: true,
    createdAt: 0,
    ...info,
    args: { cwd: CWD, engine, ...args }
  }
}

await check('instruction owners: a spawn takes its args’ or the resumed file’s', () => {
  const prompts = saved([['pi', A, P]])
  const spawned = (args: Omit<CreateAgentArgs, 'cwd'>, engine: EngineId = 'pi') =>
    withConversationPrompt({ cwd: CWD, ...args }, engine, prompts).conversationPrompt
  assert.deepEqual(spawned({ sessionPath: A }), P)
  assert.deepEqual(spawned({ forkFrom: A }), P)
  // A fork names the file it forks, not one it would resume.
  assert.deepEqual(spawned({ forkFrom: A, sessionPath: B }), P)
  // Instructions in the args win, a removal too; another engine's entry is not this one's.
  assert.deepEqual(spawned({ sessionPath: A, conversationPrompt: Q }), Q)
  assert.equal(spawned({ sessionPath: A, conversationPrompt: null }), null)
  assert.equal(spawned({ sessionPath: A }, 'prime'), undefined)
  assert.throws(() => spawned({ conversationPrompt: { ...P, text: ' ' } }))
})

await check('instruction owners: a crashed change or removal is applied, not undone', () => {
  const prompts = saved([['pi', A, P]])
  const owners = new ConversationPromptOwners(prompts)
  // The removal restart crashed: its args hold the removal and no file was read.
  const removing = agent({ sessionPath: A, conversationPrompt: null }, { status: 'crashed' })
  owners.started(removing, removing.args.sessionPath)
  assert.equal(owners.instructionsFor(removing)(A), null)
  const changing = agent({ sessionPath: A, conversationPrompt: Q }, { status: 'crashed' })
  owners.started(changing, changing.args.sessionPath)
  assert.deepEqual(owners.instructionsFor(changing)(A), Q)
  // Nothing pending: the saved entry.
  const resumed = agent({ sessionPath: A }, { sessionFile: A })
  owners.started(resumed)
  assert.deepEqual(owners.instructionsFor(resumed)(A), P)
})

await check('instruction owners: a process an extension moved runs that file’s', () => {
  const prompts = saved([['pi', B, Q]])
  const owners = new ConversationPromptOwners(prompts)
  const running = agent({ sessionPath: A, conversationPrompt: P }, { sessionFile: A })
  owners.started(running)
  // Started for A, the process now runs B: A's instructions in its args are not B's.
  assert.deepEqual(owners.instructionsFor(running)(B), Q)
  const bare = new ConversationPromptOwners(saved([]))
  bare.started(running)
  assert.equal(bare.instructionsFor(running)(B), undefined)
  // An agent nobody tracked has only saved instructions.
  assert.equal(owners.instructionsFor({ ...running, agentId: 'agent-2' })(A), undefined)
})

await check('instruction owners: a temporary chat keeps its own only for its own file', () => {
  const prompts = saved([['pi', B, Q]])
  const owners = new ConversationPromptOwners(prompts)
  const temporary = agent({ noSession: true, conversationPrompt: P })
  owners.started(temporary)
  assert.equal(owners.instructionsFor(temporary)(undefined), P)
  // An Engine temporary chat that opened a saved conversation runs that one's instructions.
  assert.deepEqual(owners.instructionsFor(temporary)(B), Q)
  assert.equal(owners.instructionsFor(temporary)(A), undefined)
  // Engine 2 promotes a temporary chat to a saved one: the same conversation, unless that file has
  // its own.
  const engine2 = agent({ engine: 'prime', noSession: true, conversationPrompt: P })
  owners.started(engine2)
  assert.deepEqual(owners.instructionsFor(engine2)(A), P)
  const promoted = new ConversationPromptOwners(saved([['prime', A, Q]]))
  promoted.started(engine2)
  assert.deepEqual(promoted.instructionsFor(engine2)(A), Q)
  // A saved chat whose file was not known when it started keeps its own for the file it gets.
  const unread = agent({ conversationPrompt: P })
  owners.started(unread)
  assert.deepEqual(owners.instructionsFor(unread)(A), P)
})

await check('instruction owners: session commands move the owner and carry forks', () => {
  const owners = new ConversationPromptOwners(saved([]))
  const before = agent({ sessionPath: A, conversationPrompt: P }, { sessionFile: A })
  owners.started(before)
  // A fork in place: the process keeps its flags, so the derived file gets its instructions.
  const forked = { ...before, sessionFile: F }
  owners.replaced(forked)
  assert.deepEqual(owners.instructionsFor(forked)(F), P)
  assert.equal(owners.instructionsFor(forked)(A), undefined)
  assert.deepEqual(carriedPrompt(forked, P, savedSessionFile(before)), {
    engine: 'pi',
    sessionFile: F,
    prompt: P
  })
  // A command that failed before the engine moved carries nothing.
  assert.equal(carriedPrompt(before, P, savedSessionFile(before)), undefined)
  assert.equal(carriedPrompt(forked, undefined, A), undefined)
  const temporary = { ...forked, args: { ...forked.args, noSession: true } }
  assert.equal(carriedPrompt(temporary, P, A), undefined)
  // A command that failed while the file is unknown keeps the owner it had.
  const unread = agent({ sessionPath: A, conversationPrompt: P })
  owners.started(unread, A)
  owners.replaced(unread)
  assert.deepEqual(owners.instructionsFor(unread)(A), P)
  owners.closed(unread.agentId)
  assert.equal(owners.instructionsFor(unread)(A), undefined)

  assert.deepEqual(piSessionReplacement({ type: 'switch_session', sessionPath: B }), {
    kind: 'switch',
    target: B
  })
  assert.deepEqual(piSessionReplacement({ type: 'new_session' }), { kind: 'switch' })
  assert.deepEqual(piSessionReplacement({ type: 'fork', entryId: 'e1' }), { kind: 'derive' })
  assert.deepEqual(piSessionReplacement({ type: 'clone' }), { kind: 'derive' })
  assert.equal(piSessionReplacement({ type: 'get_state' }), null)
  assert.deepEqual(primeSessionReplacement('switch_session', { sessionPath: B }), {
    kind: 'switch',
    target: B
  })
  assert.deepEqual(primeSessionReplacement('switch_session', { sessionPath: 3 }), {
    kind: 'switch',
    target: undefined
  })
  assert.deepEqual(primeSessionReplacement('import_jsonl', undefined), { kind: 'switch' })
  assert.deepEqual(primeSessionReplacement('fork', {}), { kind: 'derive' })
  assert.equal(primeSessionReplacement('clone', {}), null)
})

await check('instruction owners: an in-place switch never mixes two conversations', () => {
  const prompts = saved([['pi', B, Q]])
  const plain = agent({ sessionPath: A }, { sessionFile: A })
  assert.doesNotThrow(() => assertInPlaceSwitch(plain, prompts, undefined))
  assert.doesNotThrow(() => assertInPlaceSwitch(plain, prompts, A))
  assert.throws(() => assertInPlaceSwitch(plain, prompts, B), /their own engine/)
  const instructed = agent({ sessionPath: A, conversationPrompt: P }, { sessionFile: A })
  assert.throws(() => assertInPlaceSwitch(instructed, prompts, undefined), /their own engine/)
  // Only the target's own engine has its entry.
  assert.doesNotThrow(() =>
    assertInPlaceSwitch(agent({ engine: 'prime', sessionPath: A }), prompts, B)
  )
})

await check('instruction owners: a restart saves what it applied, a removal too', () => {
  assert.deepEqual(appliedPrompt(agent({ sessionPath: A, conversationPrompt: Q })), {
    engine: 'pi',
    sessionFile: A,
    prompt: Q
  })
  assert.deepEqual(
    appliedPrompt(agent({ engine: 'prime', conversationPrompt: null }, { sessionFile: B })),
    { engine: 'prime', sessionFile: B, prompt: null }
  )
  assert.equal(appliedPrompt(agent({ sessionPath: A })), undefined)
  assert.equal(appliedPrompt(agent({ noSession: true, conversationPrompt: P })), undefined)
  // A fork spawn writes a new file: it has none to resume until its engine reports it.
  assert.equal(appliedPrompt(agent({ forkFrom: A, conversationPrompt: P })), undefined)
})

await check('instruction owners: a chat closed before writing its file forgets them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vengeance-owner-'))
  try {
    const empty = join(directory, 'empty.jsonl')
    const written = join(directory, 'written.jsonl')
    await writeFile(written, '{}\n')
    const prompts = saved([
      ['pi', empty, P],
      ['pi', written, P],
      ['prime', empty, P]
    ])
    const closed = agent({ sessionPath: empty, conversationPrompt: P }, { sessionFile: empty })
    assert.deepEqual(await unwrittenPrompt(closed, [], prompts), {
      engine: 'pi',
      sessionFile: empty,
      prompt: null
    })
    // Its state read failed: the file it resumed.
    assert.deepEqual(
      (await unwrittenPrompt(agent({ sessionPath: empty }), [], prompts))?.sessionFile,
      empty
    )
    const other = agent({ sessionPath: empty }, { agentId: 'agent-2', sessionFile: empty })
    assert.equal(await unwrittenPrompt(closed, [other], prompts), undefined)
    assert.equal(
      await unwrittenPrompt(agent({ sessionPath: written }, { sessionFile: written }), [], prompts),
      undefined
    )
    assert.equal(await unwrittenPrompt(closed, [], saved([])), undefined)
    assert.equal(await unwrittenPrompt(agent({ noSession: true }), [], prompts), undefined)
    // An Engine 2 resident can still write after its client detached.
    assert.equal(
      await unwrittenPrompt(agent({ engine: 'prime' }, { sessionFile: empty }), [], prompts),
      undefined
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
