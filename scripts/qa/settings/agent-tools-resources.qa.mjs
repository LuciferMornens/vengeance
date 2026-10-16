// Settings → Agent behavior (tools, shell, codemode) and Settings → Resources (skill/prompt/extension
// paths, skill commands): the real controls, the JSON written, and what the Engine loads or sends.
//
//   node scripts/qa/settings/agent-tools-resources.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  addListItems,
  choose,
  closeSettings,
  dismissToasts,
  fill,
  LAUNCH,
  openSettings,
  readJsonOrNull,
  restartFromToast,
  sendAndCapture,
  setSwitch,
  settingRow,
  softSteps,
  waitFor,
  waitForJsonValue
} from './settings-ui.mjs'

const SKILL = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nQA.\n`

const EXTENSION = `export default function (pi) {
  pi.registerCommand('qa-ext-cmd', { description: 'QA extension command', handler: async () => {} })
}
`

async function commandNames(app) {
  const { commands } = await app.rpc({ type: 'get_commands' })
  return commands.map((command) => command.name)
}

/** Click one tool tile of the Default tools editor. */
async function toggleTool(app, name) {
  await settingRow(app, 'defaultTools')
    .locator('button', {
      has: app.page.locator('span.font-mono', { hasText: new RegExp(`^${name}$`) })
    })
    .click()
}

/** Run one bash tool call through the fake LLM and return its tool result. */
async function runBash(app, server, command) {
  const id = `toolu_${Math.random().toString(36).slice(2, 10)}`
  const from = server.requests.length
  server.queue(turn.toolCalls([{ id, name: 'bash', args: { command } }]), turn.text('done'))
  await app.send(`run ${command}`.slice(0, 60))
  await app.waitForSettle()
  const followUp = await server.waitForRequest(
    (request) => inspectRequest(request).toolResults.some((result) => result.toolCallId === id),
    { from }
  )
  return inspectRequest(followUp).toolResults.find((result) => result.toolCallId === id)
}

async function toolsSent(app, server, text) {
  return inspectRequest(await sendAndCapture(app, server, text, turn.text('ok'))).tools
}

await runSuite(
  'settings-agent-tools-resources',
  async (context) => {
    const { server, agentDir, app } = context
    const { check: step, finish } = softSteps(context, 'settings-agent-tools-resources')
    const settingsPath = agentDir.path('settings.json')
    const extraSkills = agentDir.path('../extra-skills')
    const extraPrompts = agentDir.path('../extra-prompts')
    const extension = agentDir.path('../extra-ext/qa-ext.ts')
    await agentDir.writeText('skills/qa-skill/SKILL.md', SKILL('qa-skill', 'Agent-dir QA skill.'))
    await agentDir.writeText(
      '../extra-skills/qa-extra/SKILL.md',
      SKILL('qa-extra', 'Extra QA skill.')
    )
    await agentDir.writeText(
      '../extra-prompts/qa-prompt.md',
      '---\ndescription: QA prompt\n---\nSay QA.\n'
    )
    await agentDir.writeText('../extra-ext/qa-ext.ts', EXTENSION)
    let agentId

    await step('baseline: agent-dir skill loaded, extra resources not, default tools', async () => {
      ;({ agentId } = await app.openWorkspace())
      const names = await commandNames(app)
      assert.ok(names.includes('skill:qa-skill'), names.join(', '))
      for (const missing of ['skill:qa-extra', 'qa-prompt', 'qa-ext-cmd']) {
        assert.ok(!names.includes(missing), `${missing} not loaded yet`)
      }
      const tools = await toolsSent(app, server, 'baseline tools')
      assert.deepEqual([...tools].sort(), ['bash', 'edit', 'read', 'write'])
    })

    await step(
      'Resources: skill, prompt and extension paths are written and load after restart',
      async () => {
        await openSettings(app, 'Resources')
        await addListItems(app, 'skills', [extraSkills])
        await waitForJsonValue(settingsPath, 'skills', [extraSkills])
        await addListItems(app, 'prompts', [extraPrompts])
        await waitForJsonValue(settingsPath, 'prompts', [extraPrompts])
        await addListItems(app, 'extensions', [extension])
        await waitForJsonValue(settingsPath, 'extensions', [extension])
        await restartFromToast(app, agentId)
        const names = await commandNames(app)
        for (const loaded of ['skill:qa-extra', 'qa-prompt', 'qa-ext-cmd']) {
          assert.ok(names.includes(loaded), `${loaded} in ${names.join(', ')}`)
        }
      }
    )

    await step(
      'Skill commands off is written; the composer stops offering /skill: commands',
      async () => {
        await setSwitch(app, 'enableSkillCommands', false)
        await waitForJsonValue(settingsPath, 'enableSkillCommands', false)
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const composer = app.page.getByRole('textbox', { name: 'Message' })
        await composer.fill('/skill:')
        const menu = app.page.getByRole('listbox')
        await menu.waitFor()
        await app.page.waitForTimeout(300)
        const offered = await menu.getByRole('option').allInnerTexts()
        await app.screenshot('settings-skill-commands-off')
        await composer.fill('')
        assert.deepEqual(
          offered.filter((text) => text.includes('skill:')),
          [],
          `skill commands still offered: ${offered.join(' | ')}`
        )
      }
    )

    await step('Default tools: +grep is written and the Engine declares grep', async () => {
      await openSettings(app, 'Agent behavior')
      await dismissToasts(app)
      await toggleTool(app, 'grep')
      await waitForJsonValue(settingsPath, 'defaultTools', ['+grep'])
      await restartFromToast(app, agentId)
      await closeSettings(app)
      const tools = await toolsSent(app, server, 'tools with grep')
      assert.deepEqual([...tools].sort(), ['bash', 'edit', 'grep', 'read', 'write'])
    })

    await step(
      'Default tools: removing bash writes ["+grep","-bash"]; bash is no longer declared',
      async () => {
        await openSettings(app, 'Agent behavior')
        await toggleTool(app, 'bash')
        await waitForJsonValue(settingsPath, 'defaultTools', ['+grep', '-bash'])
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const tools = await toolsSent(app, server, 'tools without bash')
        assert.deepEqual([...tools].sort(), ['edit', 'grep', 'read', 'write'])
      }
    )

    await step(
      'Default tools: "Exact selection" writes the plain list; reset removes the key',
      async () => {
        await openSettings(app, 'Agent behavior')
        await settingRow(app, 'defaultTools')
          .getByRole('radio', { name: 'Exact selection' })
          .click()
        await waitForJsonValue(settingsPath, 'defaultTools', ['read', 'edit', 'write', 'grep'])
        await settingRow(app, 'defaultTools').hover()
        await settingRow(app, 'defaultTools')
          .getByRole('button', { name: 'Reset to default' })
          .click()
        await waitFor(
          async () => !('defaultTools' in ((await readJsonOrNull(settingsPath)) ?? {})),
          'defaultTools removed'
        )
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const tools = await toolsSent(app, server, 'tools after reset')
        assert.deepEqual([...tools].sort(), ['bash', 'edit', 'read', 'write'])
      }
    )

    await step('Command prefix is written and prepended to every bash command', async () => {
      await openSettings(app, 'Agent behavior')
      await fill(app, 'shellCommandPrefix', 'export QA_PREFIX=from-prefix')
      await waitForJsonValue(settingsPath, 'shellCommandPrefix', 'export QA_PREFIX=from-prefix')
      await restartFromToast(app, agentId)
      await closeSettings(app)
      const result = await runBash(app, server, 'echo "prefix=$QA_PREFIX"')
      assert.match(result.text, /prefix=from-prefix/)
    })

    await step(
      'Shell executable is written and the bash tool uses it (missing path → error)',
      async () => {
        const missing = agentDir.path('../no-such-shell/bash.exe')
        await openSettings(app, 'Agent behavior')
        await fill(app, 'shellPath', missing)
        await waitForJsonValue(settingsPath, 'shellPath', missing)
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const result = await runBash(app, server, 'echo should-not-run')
        assert.equal(result.isError, true, result.text)
        assert.match(result.text, /no-such-shell/)
        await openSettings(app, 'Agent behavior')
        await fill(app, 'shellPath', '')
        await waitFor(
          async () => !('shellPath' in ((await readJsonOrNull(settingsPath)) ?? {})),
          'shellPath removed'
        )
        await restartFromToast(app, agentId)
      }
    )

    await step(
      'Codemode "Only" + codemode tool: the Engine declares codemode instead of tools',
      async () => {
        await toggleTool(app, 'codemode')
        await waitForJsonValue(settingsPath, 'defaultTools', ['+codemode'])
        await choose(app, 'codemode.mode', 'Only')
        await waitForJsonValue(settingsPath, 'codemode', { mode: 'only' })
        await fill(app, 'codemode.inlineBudget', 0)
        await waitForJsonValue(settingsPath, 'codemode', { mode: 'only', inlineBudget: 0 })
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const tools = await toolsSent(app, server, 'codemode only')
        assert.ok(tools.includes('codemode'), tools.join(', '))
        assert.ok(!tools.includes('bash') && !tools.includes('read'), tools.join(', '))
        await app.screenshot('settings-agent-tools')
      }
    )

    finish()
  },
  { launch: LAUNCH }
)
