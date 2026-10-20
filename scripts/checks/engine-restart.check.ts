import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EngineManager, RestartApplied } from '../../src/main/engine/manager'
import type { primeRestartSelection } from '../../src/main/engine/prime/restart'
import type {
  AgentInfo,
  ConversationPrompt,
  CreateAgentArgs,
  EngineId
} from '../../src/shared/api/engine'
import { MOCK_MODELS } from '../../src/main/engine/mock-data'
import { check } from './harness'

interface RestartFixtureModule {
  EngineManager: typeof EngineManager
  primeRestartSelection: typeof primeRestartSelection
}

async function loadManager(): Promise<RestartFixtureModule> {
  const root = process.cwd()
  const temporary = await mkdtemp(join(tmpdir(), 'vengeance-restart-module-'))
  const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
  const outfile = join(temporary, 'manager.mjs')
  try {
    await esbuild.build({
      stdin: {
        contents: [
          "export { EngineManager } from './src/main/engine/manager'",
          "export { primeRestartSelection } from './src/main/engine/prime/restart'"
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
            bundler.onResolve({ filter: /^(?:\.\/|\.\.\/)mock$/ }, () => ({
              path: 'mock-engine',
              namespace: 'fixture'
            }))
            bundler.onResolve({ filter: /^electron$/ }, () => ({
              path: 'electron',
              namespace: 'fixture'
            }))
            bundler.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
              contents: `export const app = {
                isPackaged: false,
                getAppPath: () => ${JSON.stringify(root)},
                getPath: () => ${JSON.stringify(temporary)}
              }
              export const safeStorage = { isEncryptionAvailable: () => false }
              export const shell = {}`,
              loader: 'js'
            }))
            bundler.onLoad({ filter: /^mock-engine$/, namespace: 'fixture' }, () => ({
              contents: `import { MockEngineProcess as NativeMock }
                from ${JSON.stringify(join(root, 'src/main/engine/mock.ts'))}
              export class MockEngineProcess extends NativeMock {
                constructor(args, ...rest) {
                  super(args, ...rest)
                  this.fixtureName = args.name
                  // Like Engine 2, a prime fixture applies the restart's configuration natively,
                  // unless no resident runs: then only the successor's spawn applies it.
                  if (args.engine === 'prime') {
                    this.prepareRestart = async (nextArgs) => ({
                      args: nextArgs,
                      applied: args.name !== 'no-resident'
                    })
                  }
                }
                async start() {
                  if (this.fixtureName === 'start-fails') throw new Error('The engine did not attach')
                  return super.start()
                }
                async send(command) {
                  if (command.type === 'get_commands' && this.fixtureName === 'commands-timeout') {
                    throw new Error('Engine did not answer "get_commands" within 30s')
                  }
                  const response = await super.send(command)
                  if (command.type !== 'get_state') return response
                  if (this.fixtureName === 'unverifiable-state') {
                    return { ...response, success: false, error: 'State unavailable' }
                  }
                  if (this.fixtureName === 'unobserved-compaction' && response.success) {
                    return { ...response, data: { ...response.data, isCompacting: true } }
                  }
                  return response
                }
              }`,
              loader: 'js',
              resolveDir: root
            }))
          }
        }
      ],
      logLevel: 'warning'
    })
    return (await import(pathToFileURL(outfile).href)) as RestartFixtureModule
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const { EngineManager: Manager, primeRestartSelection: selectPrimeRestart } = await loadManager()

await check(
  'engine restart: Engine 2 distinguishes explicit selection resets from omitted fields',
  () => {
    const previous: CreateAgentArgs = {
      engine: 'prime',
      cwd: process.cwd(),
      provider: 'initial-provider',
      model: 'initial-model',
      thinking: 'low'
    }
    const state = {
      model: { provider: 'live-provider', id: 'live-model' },
      thinkingLevel: 'high'
    }
    const carried = selectPrimeRestart(previous, previous, state, {})
    assert.equal(carried.provider, 'live-provider')
    assert.equal(carried.model, 'live-model')
    assert.equal(carried.thinking, 'high')
    const explicit = selectPrimeRestart(previous, previous, state, {
      provider: previous.provider,
      model: previous.model,
      thinking: previous.thinking
    })
    assert.equal(explicit.provider, previous.provider)
    assert.equal(explicit.model, previous.model)
    assert.equal(explicit.thinking, previous.thinking)
    const modelOnly = selectPrimeRestart(previous, previous, state, { model: previous.model })
    assert.equal(modelOnly.provider, 'live-provider')
    assert.equal(modelOnly.model, previous.model)
    assert.equal(modelOnly.thinking, 'high')
    const cleared = selectPrimeRestart(previous, { ...previous, thinking: undefined }, state, {
      thinking: undefined
    })
    assert.equal(cleared.thinking, undefined)
  }
)

for (const name of ['unverifiable-state', 'unobserved-compaction']) {
  await check(`engine restart: ${name} keeps its live process available`, async () => {
    const test = await fixture('pi', false, name)
    try {
      await assert.rejects(test.manager.restart(test.source.agentId), /verify|active work/)
      assert.equal(test.manager.get(test.source.agentId)?.createdAt, test.source.createdAt)
      assert.deepEqual(test.exits, [])
      const stopped = await test.manager.command(test.source.agentId, { type: 'abort' })
      assert.equal(stopped.success, true)
    } finally {
      await test.close()
    }
  })
}

await check(
  'engine restart: explicit initial model and reasoning override the live selection',
  async () => {
    const test = await fixture()
    try {
      const initial = MOCK_MODELS[0]!
      const live = MOCK_MODELS[1]!
      const source = await test.manager.create({
        cwd: test.source.cwd,
        provider: initial.provider,
        model: initial.id,
        thinking: 'medium'
      })
      await test.manager.command(source.agentId, {
        type: 'set_model',
        provider: live.provider,
        modelId: live.id
      })
      await test.manager.command(source.agentId, { type: 'set_thinking_level', level: 'high' })
      const restarted = await test.manager.restart(source.agentId, {
        provider: initial.provider,
        model: initial.id,
        thinking: 'medium'
      })
      assert.equal(restarted.status, 'ready')
      assert.equal(restarted.args.provider, initial.provider)
      assert.equal(restarted.args.model, initial.id)
      assert.equal(restarted.args.thinking, 'medium')
    } finally {
      await test.close()
    }
  }
)

async function fixture(engine: EngineId = 'pi', noSession = false, name?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'vengeance-restart-check-'))
  const exits: string[] = []
  const dialogs: string[] = []
  const manager = new Manager(
    {
      onEvent(_agentId, event) {
        if (
          event.type === 'extension_ui_request' &&
          (event.method === 'confirm' || event.method === 'select')
        ) {
          dialogs.push(event.id)
        }
      },
      onStatus() {},
      onExit: ({ agentId }) => exits.push(agentId)
    },
    { mock: true, engineOverridePath: () => null, bridgeExtensionPath: () => null }
  )
  const source = await manager.create({ engine, cwd, noSession, name })
  assert.equal(source.status, 'ready')
  return {
    manager,
    source,
    exits,
    dialogs,
    async close() {
      await manager.disposeAll()
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

await check(
  'engine restart: standalone extension dialogs stay answerable after refusal',
  async () => {
    const test = await fixture()
    try {
      const result = await test.manager.command(test.source.agentId, {
        type: 'prompt',
        message: '/mock-ui confirm'
      })
      assert.equal(result.success, true)
      assert.equal(test.manager.get(test.source.agentId)?.busy, false)
      assert.equal(test.dialogs.length, 1)
      await assert.rejects(test.manager.restart(test.source.agentId), /extension dialog/)
      await assertSessionKept(test.manager, test.source, test.exits)
      test.manager.respondUi(test.source.agentId, {
        type: 'extension_ui_response',
        id: test.dialogs[0]!,
        confirmed: true
      })
      assert.equal((await test.manager.restart(test.source.agentId)).status, 'ready')
    } finally {
      await test.close()
    }
  }
)

async function assertSessionKept(
  manager: EngineManager,
  source: AgentInfo,
  exits: string[]
): Promise<void> {
  assert.equal(manager.get(source.agentId)?.status, 'ready')
  assert.equal(manager.get(source.agentId)?.createdAt, source.createdAt)
  assert.deepEqual(exits, [])
  const response = await manager.command(source.agentId, { type: 'get_state' })
  assert.equal(response.success, true)
}

await check(
  'engine restart: Stop clears run dialogs while keeping standalone dialogs',
  async () => {
    const test = await fixture()
    try {
      await test.manager.command(test.source.agentId, {
        type: 'prompt',
        message: '/mock-ui confirm'
      })
      await test.manager.mockPlay(test.source.agentId, {
        script: 'showcase',
        pauseAt: 'settled',
        instant: true
      })
      assert.equal(test.dialogs.length, 2)
      assert.equal(
        (await test.manager.command(test.source.agentId, { type: 'abort' })).success,
        true
      )
      await assert.rejects(test.manager.restart(test.source.agentId), /extension dialog/)
      test.manager.respondUi(test.source.agentId, {
        type: 'extension_ui_response',
        id: test.dialogs[0]!,
        confirmed: true
      })
      assert.equal((await test.manager.restart(test.source.agentId)).status, 'ready')
    } finally {
      await test.close()
    }
  }
)

for (const engine of ['pi', 'prime'] as const) {
  await check(
    `engine restart: ${engine} keeps a running conversation and accepts Stop`,
    async () => {
      const test = await fixture(engine)
      try {
        await test.manager.mockPlay(test.source.agentId, {
          script: 'short',
          pauseAt: 'short-text',
          instant: true
        })
        await assert.rejects(test.manager.restart(test.source.agentId), /active work/)
        await assertSessionKept(test.manager, test.source, test.exits)
        assert.equal(test.manager.get(test.source.agentId)?.busy, true)
        const stopped = await test.manager.command(test.source.agentId, { type: 'abort' })
        assert.equal(stopped.success, true)
        assert.equal(test.manager.get(test.source.agentId)?.busy, false)
      } finally {
        await test.close()
      }
    }
  )

  for (const type of ['compact', 'bash'] as const) {
    await check(`engine restart: ${engine} lets an admitted ${type} finish`, async () => {
      const test = await fixture(engine)
      try {
        const active = test.manager.command(
          test.source.agentId,
          type === 'bash' ? { type, command: 'git status' } : { type }
        )
        await assert.rejects(test.manager.restart(test.source.agentId), /operation to finish/)
        assert.equal((await active).success, true)
        await assertSessionKept(test.manager, test.source, test.exits)
      } finally {
        await test.close()
      }
    })
  }

  await check(
    `engine restart: ${engine} keeps temporary history after refusing restart`,
    async () => {
      const test = await fixture(engine, true)
      try {
        await test.manager.command(test.source.agentId, { type: 'bash', command: 'git status' })
        const before = await test.manager.command(test.source.agentId, { type: 'get_messages' })
        await assert.rejects(test.manager.restart(test.source.agentId), /Temporary conversations/)
        assert.deepEqual(
          await test.manager.command(test.source.agentId, { type: 'get_messages' }),
          before
        )
        await assertSessionKept(test.manager, test.source, test.exits)
      } finally {
        await test.close()
      }
    }
  )
}

await check('engine restart: parked Engine steering and follow-ups stay queued', async () => {
  const test = await fixture()
  try {
    await test.manager.mockPlay(test.source.agentId, {
      script: 'short',
      pauseAt: 'short-text',
      instant: true
    })
    for (const type of ['steer', 'follow_up'] as const) {
      const queued = await test.manager.command(test.source.agentId, {
        type,
        message: `Keep parked ${type}`
      })
      assert.equal(queued.success, true)
    }
    assert.equal((await test.manager.command(test.source.agentId, { type: 'abort' })).success, true)
    await assert.rejects(test.manager.restart(test.source.agentId), /queued messages/)
    await assertSessionKept(test.manager, test.source, test.exits)
    const cleared = await test.manager.command(test.source.agentId, { type: 'clear_queue' })
    assert.equal(cleared.success, true)
    if (cleared.success && cleared.command === 'clear_queue') {
      assert.deepEqual(cleared.data, {
        steering: ['Keep parked steer'],
        followUp: ['Keep parked follow_up']
      })
    }
  } finally {
    await test.close()
  }
})

await check('engine restart: preparation excludes new work and duplicate restarts', async () => {
  const test = await fixture()
  try {
    const restarting = test.manager.restart(test.source.agentId)
    await assert.rejects(
      test.manager.command(test.source.agentId, { type: 'prompt', message: 'Do not admit this' }),
      /restart to finish/
    )
    await assert.rejects(test.manager.bridge(test.source.agentId, { op: 'reload' }), /restart/)
    await assert.rejects(test.manager.nativeCommand(test.source.agentId, 'prompt'), /restart/)
    assert.throws(
      () =>
        test.manager.respondUi(test.source.agentId, {
          type: 'extension_ui_response',
          id: 'late-dialog',
          cancelled: true
        }),
      /restart/
    )
    await assert.rejects(test.manager.restart(test.source.agentId), /already restarting/)
    const result = await restarting
    assert.equal(result.status, 'ready')
    assert.deepEqual(test.exits, [test.source.agentId])
  } finally {
    await test.close()
  }
})

await check('engine restart: startup cannot be replaced before creation finishes', async () => {
  const test = await fixture()
  try {
    const agentId = 'restart-startup-fixture'
    const creating = test.manager.create({ cwd: test.source.cwd }, agentId)
    await assert.rejects(test.manager.restart(agentId), /operation to finish/)
    assert.equal((await creating).status, 'ready')
    assert.deepEqual(test.exits, [])
  } finally {
    await test.close()
  }
})

await check(
  'engine restart: Engine carries its current model and reasoning into the successor',
  async () => {
    const test = await fixture()
    try {
      const model = MOCK_MODELS[1]!
      await test.manager.command(test.source.agentId, {
        type: 'set_model',
        provider: model.provider,
        modelId: model.id
      })
      await test.manager.command(test.source.agentId, { type: 'set_thinking_level', level: 'high' })
      const before = await test.manager.command(test.source.agentId, { type: 'get_state' })
      assert.ok(before.success && before.command === 'get_state')
      const restarted = await test.manager.restart(test.source.agentId)
      assert.equal(restarted.status, 'ready')
      assert.equal(restarted.args.provider, model.provider)
      assert.equal(restarted.args.model, model.id)
      assert.equal(restarted.args.thinking, before.data.thinkingLevel)
      assert.equal(restarted.sessionFile, before.data.sessionFile)
    } finally {
      await test.close()
    }
  }
)

await check(
  'engine restart: conversation instructions follow the session file the restart resumes',
  async () => {
    const test = await fixture()
    const temporary = await fixture('pi', true)
    try {
      const prompt: ConversationPrompt = { mode: 'append', text: 'Answer in French.', updatedAt: 1 }
      const started = test.manager.get(test.source.agentId)?.sessionFile
      // The process moves to another session file; only its fresh state says so.
      await test.manager.command(test.source.agentId, { type: 'clone' })
      const asked: Array<string | undefined> = []
      const restarted = await test.manager.restart(test.source.agentId, undefined, (file) => {
        asked.push(file)
        return prompt
      })
      assert.equal(asked.length, 1)
      assert.ok(asked[0] && started && asked[0] !== started)
      assert.equal(asked[0], restarted.sessionFile)
      assert.deepEqual(restarted.args.conversationPrompt, prompt)

      const chat = await temporary.manager.restart(temporary.source.agentId, undefined, (file) => {
        asked.push(file)
        return null
      })
      assert.equal(asked[1], undefined)
      assert.equal(chat.args.conversationPrompt, null)
    } finally {
      await test.close()
      await temporary.close()
    }
  }
)

/** Records each successor a restart reports as applied. */
function appliedLog(): {
  applied: Array<Pick<AgentInfo, 'args' | 'sessionFile'>>
  onApplied: RestartApplied
} {
  const applied: Array<Pick<AgentInfo, 'args' | 'sessionFile'>> = []
  return {
    applied,
    onApplied: async (successor) => {
      applied.push(successor)
    }
  }
}

await check('engine restart: the Engine applies a configuration once its spawn starts', async () => {
  const test = await fixture()
  try {
    const { applied, onApplied } = appliedLog()
    const crashed = await test.manager.restart(
      test.source.agentId,
      { name: 'start-fails' },
      undefined,
      onApplied
    )
    assert.equal(crashed.status, 'crashed')
    assert.equal(applied.length, 0)
    const ready = await test.manager.restart(
      test.source.agentId,
      { name: undefined },
      undefined,
      onApplied
    )
    assert.equal(ready.status, 'ready')
    assert.equal(applied.length, 1)
    assert.equal(applied[0]!.sessionFile, ready.sessionFile)
  } finally {
    await test.close()
  }
})

await check(
  'engine restart: Engine 2 keeps a natively applied configuration when the re-attach fails',
  async () => {
    const test = await fixture('prime')
    try {
      const prompt: ConversationPrompt = { mode: 'append', text: 'Answer in French.', updatedAt: 1 }
      const { applied, onApplied } = appliedLog()
      const crashed = await test.manager.restart(
        test.source.agentId,
        { name: 'start-fails', conversationPrompt: prompt },
        undefined,
        onApplied
      )
      assert.equal(crashed.status, 'crashed')
      assert.equal(applied.length, 1)
      assert.deepEqual(applied[0]!.args.conversationPrompt, prompt)
      assert.equal(applied[0]!.args.sessionPath, test.source.sessionFile)
      // A spawn after a failed startup applies nothing natively: only one that starts counts.
      await test.manager.restart(test.source.agentId, undefined, undefined, onApplied)
      assert.equal(applied.length, 1)
      const ready = await test.manager.restart(
        test.source.agentId,
        { name: undefined },
        undefined,
        onApplied
      )
      assert.equal(ready.status, 'ready')
      assert.equal(applied.length, 2)
      assert.deepEqual(applied[1]!.args.conversationPrompt, prompt)
    } finally {
      await test.close()
    }
  }
)

await check(
  'engine restart: Engine 2 without a resident applies a configuration once its spawn starts',
  async () => {
    const test = await fixture('prime', false, 'no-resident')
    try {
      const prompt: ConversationPrompt = { mode: 'append', text: 'Answer in French.', updatedAt: 1 }
      const { applied, onApplied } = appliedLog()
      const crashed = await test.manager.restart(
        test.source.agentId,
        { name: 'start-fails', conversationPrompt: prompt },
        undefined,
        onApplied
      )
      assert.equal(crashed.status, 'crashed')
      assert.equal(applied.length, 0, 'no resident and no successor took the configuration')
      const ready = await test.manager.restart(
        test.source.agentId,
        { name: 'no-resident' },
        undefined,
        onApplied
      )
      assert.equal(ready.status, 'ready')
      assert.equal(applied.length, 1)
      assert.deepEqual(applied[0]!.args.conversationPrompt, prompt)
      // Reported by the successor that started, not by the preparation before it.
      const again = await test.manager.restart(test.source.agentId, undefined, undefined, onApplied)
      assert.equal(again.status, 'ready')
      assert.equal(applied.length, 2)
      assert.equal(applied[1]!.sessionFile, again.sessionFile)
      assert.ok(applied[1]!.sessionFile)
    } finally {
      await test.close()
    }
  }
)

await check('engine restart: a command list that times out keeps the resumed session file', async () => {
  const test = await fixture()
  try {
    const restarted = await test.manager.restart(test.source.agentId, { name: 'commands-timeout' })
    assert.equal(restarted.status, 'ready')
    assert.ok(restarted.sessionFile)
    assert.equal(restarted.sessionFile, test.source.sessionFile)
  } finally {
    await test.close()
  }
})
