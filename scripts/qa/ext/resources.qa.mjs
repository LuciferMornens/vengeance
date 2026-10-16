// Skills, prompt templates and themes from the temp agent dir and the project's .pi/ folder:
// Settings → Resources lists and toggles them, the slash menu offers them, invoking them sends the
// expanded content to the (fake) model, toggling one off removes it after the engine restart, and
// a custom theme reaches the one place a theme applies in Vengeance: the HTML export.
//
//   node scripts/qa/ext/resources.qa.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { enginePackageDir } from '../settings/engine-sdk.mjs'
import { bugSteps, reportShot, settleActive, until } from './lib/ext-helpers.mjs'

/** A valid custom theme: the engine's dark theme renamed, with a marker HTML-export page color. */
function qaTheme() {
  const dark = JSON.parse(
    readFileSync(
      join(enginePackageDir(), 'dist', 'modes', 'interactive', 'theme', 'dark.json'),
      'utf8'
    )
  )
  return { ...dark, name: 'qa-theme', export: { ...dark.export, pageBg: '#123456' } }
}

const GLOBAL_FILES = {
  'skills/qa-skill/SKILL.md':
    '---\nname: qa-skill\ndescription: QA global skill. Use when the QA suite asks for it.\n---\n\nQA-SKILL-BODY: follow the QA steps.\n',
  'prompts/qa-review.md':
    '---\ndescription: QA review template\nargument-hint: "[focus]"\n---\nQA-PROMPT-BODY review with focus=${1:-everything}\n',
  'themes/qa-theme.json': qaTheme()
}

const PROJECT_FILES = {
  'README.md': '# QA resources workspace\n',
  '.pi/skills/qa-project-skill/SKILL.md':
    '---\nname: qa-project-skill\ndescription: QA project skill from .pi/skills.\n---\n\nQA-PROJECT-SKILL-BODY\n',
  '.pi/prompts/qa-project-prompt.md':
    '---\ndescription: QA project prompt template\n---\nQA-PROJECT-PROMPT-BODY $@\n'
}

await runSuite(
  'ext-resources',
  async ({ server, agentDir, app, step }) => {
    const { page } = app
    const { bugStep, finish } = bugSteps(step)
    const composer = () => page.getByRole('textbox', { name: 'Message' })
    let cwd

    const sendAndCapture = async (text, answer) => {
      const from = server.requests.length
      server.queue(turn.text(answer))
      await app.send(text)
      await app.waitForSettle()
      return inspectRequest(await server.waitForRequest(undefined, { from }))
    }
    const commandNames = async () => (await app.agentState()).commands.map((c) => c.name)

    await step(
      'project with .pi resources asks for trust; "Trust and remember" loads them',
      async () => {
        cwd = await app.createWorkspace(PROJECT_FILES)
        const opening = app.test('openWorkspace', cwd)
        const trust = page.getByRole('dialog', { name: /^Trust/ })
        await trust.waitFor()
        await reportShot(app, 'ext-resources-trust')
        await trust.getByRole('option', { name: /Trust and remember/ }).click()
        await opening
        await composer().waitFor()
        const names = await commandNames()
        for (const name of [
          'skill:qa-skill',
          'skill:qa-project-skill',
          'qa-review',
          'qa-project-prompt'
        ]) {
          assert.ok(names.includes(name), `${name} in get_commands (${names.join(', ')})`)
        }
      }
    )

    await step('Settings → Resources lists global and project resources', async () => {
      await app.test('openSettings', 'resources')
      await page.getByText('/skill:qa-skill', { exact: true }).waitFor()
      await page.getByText('/skill:qa-project-skill', { exact: true }).waitFor()
      await page.getByText('QA review template').first().waitFor()
      await page.getByText('QA project prompt template').first().waitFor()
      await page.getByText('qa-theme', { exact: true }).waitFor()
      await reportShot(app, 'ext-resources-settings')
    })

    await bugStep('prompt templates are labelled with the command name', async () => {
      await page.getByText('/qa-review', { exact: true }).waitFor({ timeout: 2000 })
      await page.getByText('/qa-project-prompt', { exact: true }).waitFor({ timeout: 2000 })
    })

    await bugStep('the two personal resource folders have distinct group titles', async () => {
      const titles = await page.getByText(/^Agent folder/).allInnerTexts()
      assert.ok(titles.length <= 1, `${titles.length} groups titled "Agent folder"`)
    })

    await step('close settings', () => app.test('closeSettings'))

    await step('slash menu offers skills as /skill:name and prompts as /name', async () => {
      await composer().fill('/skill:qa')
      await page.getByText('QA global skill. Use when the QA suite asks for it.').waitFor()
      await reportShot(app, 'ext-resources-slash-skills')
      await composer().fill('/qa-rev')
      await page.getByText('QA review template').waitFor()
      await reportShot(app, 'ext-resources-slash-prompts')
      await composer().fill('')
    })

    await step('the skill list in the system prompt names both skills', async () => {
      const sent = await sendAndCapture('hello resources', 'Hello.')
      assert.match(sent.system, /qa-skill/)
      assert.match(sent.system, /qa-project-skill/)
    })

    await step('/qa-review security sends the expanded template', async () => {
      const sent = await sendAndCapture('/qa-review security', 'Reviewed.')
      assert.match(sent.lastUserText, /QA-PROMPT-BODY review with focus=security/)
      assert.doesNotMatch(sent.lastUserText, /^\/qa-review/)
    })

    await step('/qa-project-prompt expands the project template with all arguments', async () => {
      const sent = await sendAndCapture('/qa-project-prompt one two', 'Project prompt.')
      assert.match(sent.lastUserText, /QA-PROJECT-PROMPT-BODY one two/)
    })

    await step('/skill:qa-skill sends the skill body plus the request', async () => {
      const sent = await sendAndCapture('/skill:qa-skill check the build', 'Skill used.')
      assert.match(sent.lastUserText, /QA-SKILL-BODY: follow the QA steps\./)
      assert.match(sent.lastUserText, /check the build/)
    })

    await step('toggling a skill and a prompt off writes the engine filters', async () => {
      await app.test('openSettings', 'resources')
      await page.getByRole('switch', { name: 'Enable qa-skill' }).click()
      await page.getByRole('switch', { name: /^Enable qa-review/ }).click()
      await until(
        async () => {
          const settings = await agentDir.readJson('settings.json')
          return settings.skills?.length && settings.prompts?.length ? settings : null
        },
        { label: 'settings.json filters' }
      )
      const settings = await agentDir.readJson('settings.json')
      assert.ok(
        settings.skills.some((entry) => /^-.*qa-skill/.test(entry)),
        JSON.stringify(settings)
      )
      assert.ok(settings.prompts.some((entry) => /^-.*qa-review\.md$/.test(entry)))
      await page.locator('[data-toaster]').getByText('Restart to apply').waitFor()
      await reportShot(app, 'ext-resources-toggled-off')
    })

    await step(
      '"Restart engines" applies it: the commands and the skill listing are gone',
      async () => {
        await page
          .locator('[data-toaster]')
          .getByRole('button', { name: 'Restart engines' })
          .click()
        await app.test('closeSettings')
        await until(async () => !(await commandNames()).includes('qa-review'), {
          timeoutMs: 60_000,
          label: 'restarted engine without /qa-review'
        })
        const names = await commandNames()
        assert.ok(!names.includes('skill:qa-skill'))
        assert.ok(names.includes('skill:qa-project-skill'), 'the other skill stays')
        const sent = await sendAndCapture('after toggle', 'Still here.')
        assert.doesNotMatch(sent.system, /qa-skill\b(?!-)/, 'disabled skill not advertised')
        assert.match(sent.system, /qa-project-skill/)
      }
    )

    // ext-4: the Terminal theme picker lists the installed qa-theme next to System/Dark/Light.
    await bugStep('the Terminal theme picker offers installed custom themes', async () => {
      await app.test('openSettings', 'terminal')
      await page.getByText('Terminal theme', { exact: true }).waitFor()
      await reportShot(app, 'ext-resources-terminal-theme')
      const picker = page.locator('#setting-theme, [id="setting-theme"]').first()
      await picker.getByRole('combobox').first().click()
      await page.getByRole('option', { name: /qa-theme/ }).waitFor({ timeout: 2000 })
    })

    await step('close the theme picker', async () => {
      await page.keyboard.press('Escape')
      await app.test('closeSettings')
    })

    await step(
      'a custom theme set as the theme colors the HTML export of a new session',
      async () => {
        const settings = await agentDir.readJson('settings.json')
        await agentDir.writeText('settings.json', { ...settings, theme: 'qa-theme' })
        const live = await app.rpc({ type: 'export_html', outputPath: join(cwd, 'live.html') })
        const liveUsesTheme = /#123456/i.test(await readFile(live.path, 'utf8'))
        const before = await app.activeAgentId()
        await page.keyboard.press('Control+n')
        await until(
          async () => {
            const id = await app.activeAgentId()
            return id !== before && (await app.agentState(id))?.status === 'ready'
          },
          { timeoutMs: 60_000, label: 'a new session' }
        )
        server.queue(turn.text('Themed reply.'))
        await app.rpc({ type: 'prompt', message: 'theme check' })
        await settleActive(app)
        const fresh = await app.rpc({ type: 'export_html', outputPath: join(cwd, 'fresh.html') })
        assert.match(
          await readFile(fresh.path, 'utf8'),
          /#123456/i,
          'qa-theme export.pageBg in the HTML'
        )
        console.log(`    · a running session keeps its old theme for exports: ${!liveUsesTheme}`)
      }
    )

    // ext-7: the theme also colors Vengeance's HTML exports, so the row says "Also in Vengeance" and
    // changing it offers a restart (running sessions keep the old theme until then).
    await bugStep('the theme setting says it also applies to exports in Vengeance', async () => {
      await app.test('openSettings', 'terminal')
      const row = page.locator('[id="setting-theme"]')
      await row.waitFor()
      await row.getByText('Also in Vengeance').waitFor({ timeout: 2000 })
    })

    finish()
  },
  { agentDir: { files: GLOBAL_FILES } }
)
