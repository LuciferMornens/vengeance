import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONVERSATION_PROMPT_MAX_CHARS,
  type ConversationPrompt,
  type CreateAgentArgs
} from '../../src/shared/api/engine'
import { callBridge } from '../../src/main/engine/bridge'
import {
  primeAppendSystemText,
  primeConfiguredArgs
} from '../../src/main/engine/conversation-prompt'
import { buildEngineArgs } from '../../src/main/engine/manager'
import { MockEngineProcess } from '../../src/main/engine/mock'
import { PrimeMockEngineProcess } from '../../src/main/engine/prime/mock'
import type {
  changedConfiguration,
  PRIME_PROMPT_SOURCE_KEYS
} from '../../src/main/engine/prime/restart'
import type { primeCreatePayload } from '../../src/main/engine/prime/sessions'
import {
  ConversationPromptStore,
  conversationPromptKey,
  parseConversationPrompt,
  piConversationPromptSources
} from '../../src/main/features/sessions/conversation-prompts'
import { samePath } from '../../src/main/paths'
import { check } from './harness'

const append: ConversationPrompt = { mode: 'append', text: 'Answer in French.', updatedAt: 1 }
const replace: ConversationPrompt = {
  mode: 'replace',
  text: 'You review payment code.\n',
  updatedAt: 2
}

async function temporary<Result>(run: (directory: string) => Promise<Result>): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), 'vengeance-conversation-prompt-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

interface PrimeFixtureModule {
  primeCreatePayload: typeof primeCreatePayload
  changedConfiguration: typeof changedConfiguration
  PRIME_PROMPT_SOURCE_KEYS: typeof PRIME_PROMPT_SOURCE_KEYS
}

/** Engine 2's payload and restart diff import Electron; bundle them with a stand-in for it. */
async function loadPrime(): Promise<PrimeFixtureModule> {
  const root = process.cwd()
  return temporary(async (directory) => {
    const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
    const outfile = join(directory, 'prime.mjs')
    await esbuild.build({
      stdin: {
        contents: [
          "export { primeCreatePayload } from './src/main/engine/prime/sessions'",
          "export { changedConfiguration, PRIME_PROMPT_SOURCE_KEYS } from './src/main/engine/prime/restart'"
        ].join('\n'),
        resolveDir: root,
        loader: 'ts'
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      tsconfig: join(root, 'tsconfig.node.json'),
      alias: { '@shared': resolve(root, 'src/shared') },
      plugins: [
        {
          name: 'isolated-electron',
          setup(bundler) {
            bundler.onResolve({ filter: /^electron$/ }, () => ({
              path: 'electron',
              namespace: 'fixture'
            }))
            bundler.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
              contents: `export const app = { isPackaged: false, getPath: () => ${JSON.stringify(directory)} }
                export const safeStorage = { isEncryptionAvailable: () => false }
                export const shell = {}`,
              loader: 'js'
            }))
          }
        }
      ],
      logLevel: 'warning'
    })
    return (await import(pathToFileURL(outfile).href)) as PrimeFixtureModule
  })
}

await check(
  'conversation prompts: the IPC boundary accepts only complete, bounded instructions',
  () => {
    assert.equal(parseConversationPrompt(undefined), undefined)
    assert.equal(parseConversationPrompt(null), null)
    assert.deepEqual(parseConversationPrompt({ ...append, extra: true }), append)
    const invalid: unknown[] = [
      'text',
      { ...append, mode: 'prepend' },
      { ...append, text: ' \n\t' },
      { ...append, text: 'x'.repeat(CONVERSATION_PROMPT_MAX_CHARS + 1) },
      { ...append, updatedAt: Number.NaN },
      { mode: 'append', text: 'no time' }
    ]
    for (const value of invalid) assert.throws(() => parseConversationPrompt(value))
    assert.equal(
      parseConversationPrompt({ ...append, text: 'x'.repeat(CONVERSATION_PROMPT_MAX_CHARS) })?.text
        .length,
      CONVERSATION_PROMPT_MAX_CHARS
    )
  }
)

await check('conversation prompts: keys name one session file per engine', () => {
  const file = resolve(tmpdir(), 'Sessions', 'one.jsonl')
  assert.equal(
    conversationPromptKey('pi', file),
    conversationPromptKey('pi', join(tmpdir(), 'Sessions', 'nested', '..', 'one.jsonl'))
  )
  assert.notEqual(conversationPromptKey('pi', file), conversationPromptKey('prime', file))
  if (process.platform === 'win32') {
    assert.equal(conversationPromptKey('pi', file), conversationPromptKey('pi', file.toUpperCase()))
    assert.equal(conversationPromptKey('pi', file), conversationPromptKey('pi', `\\\\?\\${file}`))
    assert.equal(
      conversationPromptKey('pi', file),
      conversationPromptKey('pi', file.split('\\').join('/'))
    )
  }
})

await check('conversation prompts: the store round-trips, copies, clears and forgets', () =>
  temporary(async (directory) => {
    const store = new ConversationPromptStore(directory)
    const first = join(directory, 'sessions', 'first.jsonl')
    const fork = join(directory, 'sessions', 'fork.jsonl')
    assert.equal(store.get('pi', first), undefined)
    await store.set('pi', first, append)
    await store.copy({ engine: 'pi', sessionFile: first }, { engine: 'prime', sessionFile: fork })
    await store.copy({ engine: 'pi', sessionFile: fork }, { engine: 'pi', sessionFile: first })
    const reopened = new ConversationPromptStore(directory)
    assert.deepEqual(reopened.get('pi', first), append)
    assert.deepEqual(reopened.get('prime', fork), append)
    assert.equal(reopened.get('pi', fork), undefined)
    await reopened.set('pi', first, null)
    await reopened.set('pi', fork, replace)
    await reopened.forget(fork)
    const saved = JSON.parse(await readFile(join(directory, 'conversation-prompts.json'), 'utf8'))
    assert.deepEqual(saved, { version: 1, prompts: {} })
    // A damaged entry is dropped; the others still load.
    await writeFile(
      join(directory, 'conversation-prompts.json'),
      JSON.stringify({
        version: 1,
        prompts: {
          [conversationPromptKey('pi', first)]: replace,
          [conversationPromptKey('pi', fork)]: { mode: 'append', text: '' }
        }
      })
    )
    const damaged = new ConversationPromptStore(directory)
    assert.deepEqual(damaged.get('pi', first), replace)
    assert.equal(damaged.get('pi', fork), undefined)
  })
)

/** Runs `body` with the store's expected error logs silenced, returning how many it logged. */
async function quietly(body: () => Promise<void>): Promise<number> {
  const log = console.error
  let logged = 0
  console.error = () => {
    logged++
  }
  try {
    await body()
  } finally {
    console.error = log
  }
  return logged
}

await check(
  'conversation prompts: an unreadable store is read again and never written or cleaned over',
  () =>
    temporary(async (directory) => {
      const session = join(directory, 'session.jsonl')
      const storeFile = join(directory, 'conversation-prompts.json')
      const kept = await new ConversationPromptStore(directory).promptFile(append)
      // A folder in its place fails every read, like a file a scanner holds open.
      await mkdir(storeFile)
      const store = new ConversationPromptStore(directory)
      const logged = await quietly(async () => {
        assert.equal(store.get('pi', session), undefined)
        assert.throws(() => store.assertReadable(), /could not be read/)
        await assert.rejects(store.set('pi', session, replace), /could not be read/)
        await assert.rejects(store.forget(session), /could not be read/)
        await assert.rejects(store.collectGarbage(), /could not be read/)
      })
      assert.equal(logged, 1)
      assert.ok(existsSync(kept))
      await rm(storeFile, { recursive: true })
      await writeFile(
        storeFile,
        JSON.stringify({ version: 1, prompts: { [conversationPromptKey('pi', session)]: append } })
      )
      assert.deepEqual(store.get('pi', session), append)
    })
)

await check(
  'conversation prompts: a damaged store is kept aside before the first write replaces it',
  () =>
    temporary(async (directory) => {
      const session = join(directory, 'session.jsonl')
      const storeFile = join(directory, 'conversation-prompts.json')
      const kept = await new ConversationPromptStore(directory).promptFile(append)
      const damagedText = '{"version":1,"prompts":{"pi:'
      await writeFile(storeFile, damagedText)
      const store = new ConversationPromptStore(directory)
      const logged = await quietly(async () => {
        assert.equal(store.get('pi', session), undefined)
        // Its references are unknown, so startup cleanup keeps every prompt file.
        await store.collectGarbage()
      })
      assert.equal(logged, 1)
      assert.ok(existsSync(kept))
      await store.set('pi', session, replace)
      const asides = (await readdir(directory)).filter((name) =>
        name.startsWith('conversation-prompts.json.corrupt-')
      )
      assert.equal(asides.length, 1)
      assert.equal(await readFile(join(directory, asides[0]!), 'utf8'), damagedText)
      assert.deepEqual(new ConversationPromptStore(directory).get('pi', session), replace)
      await store.set('pi', session, append)
      assert.equal(
        (await readdir(directory)).filter((name) => name.includes('.corrupt-')).length,
        1
      )
    })
)

await check('conversation prompts: startup cleanup keeps every file a conversation names', () =>
  temporary(async (directory) => {
    const writer = new ConversationPromptStore(directory)
    const session = join(directory, 'session.jsonl')
    const kept = await writer.promptFile(append)
    const unused = await writer.promptFile(replace)
    assert.equal(await readFile(kept, 'utf8'), 'Answer in French.\n')
    assert.equal(await writer.promptFile({ ...append, updatedAt: 9 }), kept)
    await writer.set('pi', session, append)
    await writeFile(join(directory, 'conversation-prompts', 'notes.txt'), 'not a prompt')
    // Files handed to an engine in this run survive even when no conversation saved them.
    await writer.collectGarbage()
    assert.ok(existsSync(kept) && existsSync(unused))
    await new ConversationPromptStore(directory).collectGarbage()
    assert.ok(existsSync(kept))
    assert.ok(!existsSync(unused))
    assert.deepEqual(
      (await readdir(join(directory, 'conversation-prompts'))).sort(),
      [basename(kept), 'notes.txt'].sort()
    )
    await new ConversationPromptStore(join(directory, 'empty')).collectGarbage()
  })
)

await check('conversation prompts: Engine flags keep APPEND_SYSTEM.md or launch append first', () =>
  temporary(async (directory) => {
    const store = new ConversationPromptStore(join(directory, 'user-data'))
    const cwd = join(directory, 'project')
    const agentDir = join(directory, 'agent')
    await mkdir(join(cwd, '.pi'), { recursive: true })
    await mkdir(agentDir, { recursive: true })
    const base: CreateAgentArgs = { cwd, sessionPath: join(cwd, 's.jsonl') }
    const trusted = async () => true
    const untrusted = async () => false
    const sources = (args: CreateAgentArgs, projectTrusted = trusted) =>
      piConversationPromptSources(store, args, agentDir, projectTrusted)
    assert.equal(await sources(base), undefined)
    assert.equal(await sources({ ...base, conversationPrompt: null }), undefined)

    const withAppend = { ...base, conversationPrompt: append }
    const alone = await sources(withAppend)
    assert.deepEqual(alone, { conversationFile: alone!.conversationFile })
    assert.deepEqual(buildEngineArgs(withAppend, null, alone), [
      '--session',
      base.sessionPath,
      '--append-system-prompt',
      alone!.conversationFile
    ])

    const globalAppend = join(agentDir, 'APPEND_SYSTEM.md')
    const projectAppend = join(cwd, '.pi', 'APPEND_SYSTEM.md')
    await writeFile(globalAppend, 'Global addendum\n')
    await writeFile(projectAppend, 'Project addendum\n')
    /** The text the Engine reads from the APPEND_SYSTEM.md source of a spawn. */
    const appended = async (args: CreateAgentArgs, projectTrusted = trusted) => {
      const file = (await sources(args, projectTrusted))?.appendSystemFile
      return file === undefined ? undefined : readFile(file, 'utf8')
    }
    const trustedSources = await sources(withAppend)
    assert.equal(await appended(withAppend), 'Project addendum\n')
    assert.equal(await appended(withAppend, untrusted), 'Global addendum\n')
    // A pinned trust decision is what the Engine applies, whatever its default would be.
    assert.equal(await appended({ ...withAppend, approve: false }), 'Global addendum\n')
    assert.equal(await appended({ ...withAppend, approve: true }, untrusted), 'Project addendum\n')
    assert.deepEqual(buildEngineArgs(withAppend, null, trustedSources).slice(2), [
      '--append-system-prompt',
      trustedSources!.appendSystemFile,
      '--append-system-prompt',
      trustedSources!.conversationFile
    ])
    // The Engine reads its sources again on a reload: it gets a copy in userData that Settings cannot
    // remove, never the user's file, whose missing path it would take as literal text.
    assert.ok(!samePath(trustedSources!.appendSystemFile!, projectAppend))
    await rm(projectAppend)
    assert.equal(await readFile(trustedSources!.appendSystemFile!, 'utf8'), 'Project addendum\n')
    assert.equal(await appended(withAppend), 'Global addendum\n')
    await writeFile(globalAppend, ' \n')
    assert.equal(await appended(withAppend), undefined)

    const launchAppend = { ...withAppend, launch: { appendSystemPrompt: ['Launch addendum'] } }
    const launchSources = await sources(launchAppend)
    assert.equal(launchSources?.appendSystemFile, undefined)
    assert.deepEqual(buildEngineArgs(launchAppend, null, launchSources).slice(2), [
      '--append-system-prompt',
      'Launch addendum',
      '--append-system-prompt',
      launchSources!.conversationFile
    ])

    const replacing = {
      ...base,
      conversationPrompt: replace,
      launch: { systemPrompt: 'Launch foundation', appendSystemPrompt: ['Launch addendum'] }
    }
    const replaceSources = await sources(replacing)
    assert.deepEqual(replaceSources, { conversationFile: replaceSources!.conversationFile })
    assert.deepEqual(buildEngineArgs(replacing, null, replaceSources).slice(2), [
      '--system-prompt',
      replaceSources!.conversationFile,
      '--append-system-prompt',
      'Launch addendum'
    ])
    assert.equal(await readFile(replaceSources!.conversationFile, 'utf8'), replace.text)
    // The stored launch options are never rewritten.
    assert.equal(replacing.launch.systemPrompt, 'Launch foundation')
  })
)

const prime = await loadPrime()

await check(
  'conversation prompts: Engine 2 create payload carries the composed configuration',
  () =>
    temporary(async (directory) => {
      const cwd = join(directory, 'project')
      const agentDir = join(directory, 'agent')
      await mkdir(join(cwd, '.prime', 'agent'), { recursive: true })
      await mkdir(agentDir, { recursive: true })
      const args: CreateAgentArgs = { engine: 'prime', cwd, conversationPrompt: append }
      const config = (value: CreateAgentArgs, text?: string) =>
        prime.primeCreatePayload(primeConfiguredArgs(value, text)).config as Record<string, unknown>
      assert.equal(await primeAppendSystemText(cwd, agentDir), undefined)
      assert.deepEqual(config(args).appendSystemPrompt, ['Answer in French.\n'])
      assert.equal(config(args).systemPrompt, undefined)
      assert.deepEqual(config({ ...args, conversationPrompt: undefined }).appendSystemPrompt, [])

      const globalAppend = join(agentDir, 'APPEND_SYSTEM.md')
      const projectAppend = join(cwd, '.prime', 'agent', 'APPEND_SYSTEM.md')
      await writeFile(globalAppend, 'Global addendum')
      // Literal text ending in a newline: a worker recreated from its descriptor never reads a path.
      assert.equal(await primeAppendSystemText(cwd, agentDir), 'Global addendum\n')
      await writeFile(projectAppend, 'Project addendum\n')
      const discovered = await primeAppendSystemText(cwd, agentDir)
      assert.equal(discovered, 'Project addendum\n')
      assert.deepEqual(config(args, discovered).appendSystemPrompt, [
        'Project addendum\n',
        'Answer in French.\n'
      ])
      // An existing project file wins, as in Engine 2's discovery, even when it is blank.
      await writeFile(projectAppend, '\n')
      assert.equal(await primeAppendSystemText(cwd, agentDir), undefined)
      const launched = { ...args, launch: { prime: { appendSystemPrompt: ['Launch addendum'] } } }
      assert.deepEqual(config(launched, discovered).appendSystemPrompt, [
        'Launch addendum',
        'Answer in French.\n'
      ])
      const replacing = config(
        { ...launched, conversationPrompt: replace, launch: { prime: { systemPrompt: 'Launch' } } },
        discovered
      )
      assert.equal(replacing.systemPrompt, replace.text)
      assert.deepEqual(replacing.appendSystemPrompt, [])
    })
)

await check(
  'conversation prompts: Engine 2 restarts patch added, changed and removed instructions',
  () => {
    const base: CreateAgentArgs = {
      engine: 'prime',
      cwd: tmpdir(),
      provider: 'p',
      model: 'm',
      thinking: 'low',
      launch: { prime: { skills: ['review'] } }
    }
    const diff = (previous: CreateAgentArgs, next: CreateAgentArgs, text?: string) =>
      prime.changedConfiguration(
        primeConfiguredArgs(previous, text),
        primeConfiguredArgs(next, text)
      )
    const appended = { ...base, conversationPrompt: append }
    assert.deepEqual(diff(base, appended), { appendSystemPrompt: ['Answer in French.\n'] })
    assert.deepEqual(diff(appended, appended), {})
    assert.deepEqual(diff(appended, { ...base, conversationPrompt: null }), {
      appendSystemPrompt: null
    })
    const replacing = { ...base, conversationPrompt: replace }
    assert.deepEqual(diff(appended, replacing), {
      systemPrompt: replace.text,
      appendSystemPrompt: null
    })
    assert.deepEqual(diff(replacing, base), { systemPrompt: null })
    // An APPEND_SYSTEM.md created, edited or removed since the resident started applies on the next restart.
    assert.deepEqual(
      prime.changedConfiguration(
        primeConfiguredArgs(appended, undefined),
        primeConfiguredArgs(appended, 'Project addendum\n')
      ),
      { appendSystemPrompt: ['Project addendum\n', 'Answer in French.\n'] }
    )
    // An attached resident's own sources are unknown: they are sent even when they look unchanged.
    assert.deepEqual(
      prime.changedConfiguration(
        primeConfiguredArgs(appended, 'Global addendum\n'),
        primeConfiguredArgs(appended, 'Global addendum\n'),
        undefined,
        prime.PRIME_PROMPT_SOURCE_KEYS
      ),
      { systemPrompt: null, appendSystemPrompt: ['Global addendum\n', 'Answer in French.\n'] }
    )
    assert.deepEqual(
      prime.changedConfiguration(appended, base, undefined, prime.PRIME_PROMPT_SOURCE_KEYS),
      { systemPrompt: null, appendSystemPrompt: null }
    )
  }
)

await check(
  'conversation prompts: mocks show the instructions in the assembled prompt',
  async () => {
    const cwd = 'C:\\Users\\dev\\projects\\aurora'
    const read = async (mock: MockEngineProcess) => {
      await mock.start()
      try {
        return await callBridge(mock, { op: 'system-prompt' }, 1000)
      } finally {
        await mock.stop()
      }
    }
    const plain = await read(new MockEngineProcess({ cwd }))
    assert.equal(plain.partial, true)
    const added = await read(new MockEngineProcess({ cwd, conversationPrompt: append }))
    assert.ok(added.text.startsWith('You are a careful coding assistant.'))
    // The Engine puts its append sources in `<addendum>`, ahead of project context and the rest.
    assert.ok(
      added.text.includes(
        '</rules>\n\n<addendum>\nAnswer in French.\n</addendum>\n\n<project_context>'
      )
    )
    const replaced = await read(new MockEngineProcess({ cwd, conversationPrompt: replace }))
    assert.ok(replaced.text.startsWith(replace.text))
    assert.ok(!replaced.text.includes('careful coding assistant'))
    assert.ok(replaced.text.includes('<project_context>'))

    const ran = new MockEngineProcess({ cwd })
    await ran.start()
    const settled = new Promise<void>((done) =>
      ran.on('event', (event) => event.type === 'agent_settled' && done())
    )
    await ran.play({ script: 'short', prompt: 'hello', instant: true })
    await settled
    assert.equal((await callBridge(ran, { op: 'system-prompt' }, 1000)).partial, undefined)
    // Like the bridge: the turn's prompt holds only while its tools and MCP servers do.
    const tools = await callBridge(ran, { op: 'tools-get' }, 1000)
    await callBridge(ran, { op: 'tools-set', names: tools.active.slice(1) }, 1000)
    assert.equal((await callBridge(ran, { op: 'system-prompt' }, 1000)).partial, true)
    await callBridge(ran, { op: 'tools-set', names: tools.active }, 1000)
    assert.equal((await callBridge(ran, { op: 'system-prompt' }, 1000)).partial, undefined)
    await callBridge(ran, { op: 'mcp', action: 'disable-project', server: 'filesystem' }, 1000)
    assert.equal((await callBridge(ran, { op: 'system-prompt' }, 1000)).partial, true)
    await ran.stop()

    // Engine 2 sessions answer through their native bridge, as the engine manager calls it.
    const readNative = async (conversationPrompt: ConversationPrompt) => {
      const native = new PrimeMockEngineProcess({ cwd, engine: 'prime', conversationPrompt })
      await native.start()
      try {
        const result = await native.bridge({ op: 'system-prompt' })
        assert.ok(result && typeof result === 'object' && 'text' in result)
        assert.ok(!('partial' in result))
        return result.text
      } finally {
        await native.stop()
      }
    }
    // Engine 2 adds its append sources after the whole assembled prompt.
    assert.ok((await readNative(append)).endsWith('factory runs.\n\nAnswer in French.'))
    const engine2 = await readNative(replace)
    assert.ok(engine2.startsWith(replace.text))
    assert.ok(!engine2.includes('# Workspace assistant'))
    assert.ok(engine2.includes('persistent Python kernel'))
  }
)
