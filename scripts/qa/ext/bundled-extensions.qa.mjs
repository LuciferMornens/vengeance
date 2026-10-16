import assert from 'node:assert/strict'
import { cp, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { reportShotsDir, ROOT } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { tempRoot } from '../lib/tmp.mjs'
import { fixture } from './lib/ext-helpers.mjs'

const packageRoot = process.env.QA_PI_PACKAGE_ROOT
const packagedExecutable = process.env.QA_PACKAGED_EXE
const lock = JSON.parse(await readFile(join(ROOT, 'engines.lock.json'), 'utf8'))
const upstreamVersion = lock.pi.tag.replace(/^v/, '')
const earlierReply = 'Conversation before restart.'
const reply = 'Extensions are working.'
const extensionPackages = await tempRoot('vengeance-extension-packages-')

try {
  const packages = []
  if (packageRoot) {
    const nodeModules = extensionPackages.path('node_modules')
    await cp(join(resolve(packageRoot), 'npm', 'node_modules'), nodeModules, {
      recursive: true,
      filter: (path) => !['.cache', '.bin'].includes(basename(path))
    })
    const blackPackage = extensionPackages.path('pi-black')
    await cp(
      join(resolve(packageRoot), 'git', 'github.com', 'paoloanzn', 'pi-black'),
      blackPackage,
      {
        recursive: true,
        filter: (path) => basename(path) !== '.git'
      }
    )
    packages.push(join(nodeModules, 'pi-openai-codex-compat'), blackPackage)
    for (const directory of packages) {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      console.log(`  copied ${metadata.name}@${metadata.version} into isolated QA storage`)
    }
  }

  await runSuite(
    'bundled-extensions',
    async ({ app, agentDir, server, step }) => {
      let agentId
      let savedSession

      async function assertExtensionsReady() {
        const descriptor = (await app.invoke('engine:list')).find(
          (entry) => entry.agentId === agentId
        )
        assert.equal(descriptor?.status, 'ready', descriptor?.error)
        assert.equal(descriptor.bridge, true)
        const state = await app.agentState(agentId)
        assert.deepEqual(state.extensionErrors, [])
        assert.equal(state.ext.statuses['qa-runtime-version'], upstreamVersion)
        const commands = await app.rpc({ type: 'get_commands' }, agentId)
        assert.ok(commands.commands.some((entry) => entry.name === 'qa-runtime-version'))
        if (packageRoot) {
          assert.ok(commands.commands.some((entry) => entry.name === 'codex-settings'))
        }
      }

      await step('load extensions with upstream SDK and package versions', async () => {
        ;({ agentId } = await app.openWorkspace({ args: { engine: 'pi' } }))
        await assertExtensionsReady()
        const description = await app.invoke('engine:describe', 'pi')
        assert.equal(description.source, 'bundled')
        assert.equal(description.version, lock.pi.version)
        await app.screenshot('extensions-loaded')
      })

      await step('save a conversation before restarting', async () => {
        server.queue(turn.text(earlierReply))
        await app.send('Reply with one short sentence.')
        await app.waitForSettle()
        savedSession = await app.rpc({ type: 'get_state' }, agentId)
        assert.ok(savedSession.sessionFile)
        assert.ok((await app.test('assistantText')).includes(earlierReply))
      })

      await step('restart without removing or disabling extensions', async () => {
        await app.invoke('engine:restart', agentId, undefined)
        await assertExtensionsReady()
        assert.deepEqual((await agentDir.readJson('settings.json')).packages, packages)
        const resumedSession = await app.rpc({ type: 'get_state' }, agentId)
        assert.equal(resumedSession.sessionId, savedSession.sessionId)
        assert.equal(resumedSession.sessionFile, savedSession.sessionFile)
        const history = await app.rpc({ type: 'get_messages' }, agentId)
        assert.ok(JSON.stringify(history.messages).includes(earlierReply))
      })

      await step('complete a model turn with the loaded extensions enabled', async () => {
        server.queue(turn.text(reply))
        await app.send('Reply with one short sentence.')
        await app.waitForSettle()
        assert.ok((await app.test('assistantText')).includes(reply))
        await assertExtensionsReady()
        await app.screenshot('extensions-after-restart')
      })
    },
    {
      agentDir: {
        settings: { packages },
        files: { 'extensions/runtime-version.ts': fixture('runtime-version.ts') }
      },
      launch: {
        ...(packagedExecutable ? { exe: resolve(packagedExecutable) } : {}),
        outDir: reportShotsDir('bundled-extensions')
      }
    }
  )
} finally {
  await extensionPackages.cleanup()
}
