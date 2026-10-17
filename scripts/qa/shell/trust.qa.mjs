// Project trust: a workspace with a project extension (.pi/extensions, registers a tool) and a
// project skill (.pi/skills). Each Trust dialog choice is clicked in the real dialog, then the
// fake-LLM request proves whether the engine loaded the project resources (tool list, system
// prompt) and trust.json in the temp engine dir proves what was remembered.
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { runPalette, shot, softSteps, waitUntil } from './lib/kit.mjs'

const PROJECT_TOOL = 'qa_project_tool'
const PROJECT_SKILL = 'qa-project-skill'

const projectFiles = (marker) => ({
  'README.md': `# trust fixture ${marker}\n`,
  '.pi/extensions/qa-trust.ts': [
    'export default function (pi) {',
    '  pi.registerTool({',
    `    name: '${PROJECT_TOOL}',`,
    "    label: 'QA project tool',",
    "    description: 'Project-scoped QA fixture tool',",
    "    parameters: { type: 'object', properties: {} },",
    "    async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} } }",
    '  })',
    '}',
    ''
  ].join('\n'),
  [`.pi/skills/${PROJECT_SKILL}/SKILL.md`]: [
    '---',
    `name: ${PROJECT_SKILL}`,
    'description: Project-scoped QA fixture skill for trust tests.',
    '---',
    '',
    'Say the word fixture.',
    ''
  ].join('\n')
})

await runSuite('shell-trust', async ({ server, agentDir, app, step: hardStep }) => {
  const { check: step, finish } = softSteps(hardStep)
  const { page } = app

  const trustJson = async () => {
    const text = await agentDir.readText('trust.json').catch(() => '{}')
    return JSON.parse(text || '{}')
  }
  const savedDecision = async (cwd) => {
    const data = await trustJson()
    const entries = data.entries ?? data.projects ?? data
    const hit = Object.entries(entries).find(([path]) => path.toLowerCase() === cwd.toLowerCase())
    if (!hit) return undefined
    const value = hit[1]
    return typeof value === 'object' && value !== null ? (value.decision ?? value.trusted) : value
  }

  /** Request the engine sends for one turn in the active session. */
  const probe = async (label) => {
    await waitUntil(
      async () => (await page.getByRole('textbox', { name: 'Message' }).count()) === 1,
      {
        timeoutMs: 5000,
        label: `one composer (have ${await page.getByRole('textbox', { name: 'Message' }).count()}, agents ${JSON.stringify((await app.invoke('engine:list')).map((a) => a.status))})`
      }
    )
    const from = server.requests.length
    server.queue(turn.text(`probe ${label}`))
    await app.send(`probe ${label}`)
    await app.waitForSettle()
    const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
    return {
      tool: sent.tools.includes(PROJECT_TOOL),
      skill: JSON.stringify(sent.system ?? '').includes(PROJECT_SKILL)
    }
  }

  /** Start opening `cwd` (hook resolves after the dialog), answer the Trust dialog by `choice`. */
  const openWithChoice = async (cwd, choice) => {
    const opening = app.test('openWorkspace', cwd)
    const dialog = page.getByRole('dialog', { name: /^Trust “/ })
    await dialog.waitFor({ timeout: 20_000 })
    await shot(page, `trust-dialog-${choice.replace(/\W+/g, '-').toLowerCase()}`)
    if (choice === 'Escape') await page.keyboard.press('Escape')
    else await dialog.getByRole('option', { name: new RegExp(`^${choice}`) }).click()
    await opening
    await page.getByRole('textbox', { name: 'Message' }).first().waitFor({ timeout: 30_000 })
  }

  /** New session in the active workspace; returns whether the Trust dialog came up. */
  const newSessionAsks = async () => {
    const before = await app.activeAgentId()
    await page.keyboard.press('ControlOrMeta+n')
    const dialog = page.getByRole('dialog', { name: /^Trust “/ })
    const asked = await Promise.race([
      dialog.waitFor({ timeout: 8000 }).then(() => true),
      waitUntil(
        async () => {
          const id = await app.activeAgentId()
          return id && id !== before && (await app.agentState(id))?.status === 'ready'
        },
        { timeoutMs: 8000, label: 'new session' }
      ).then(() => false)
    ])
    return asked
  }

  await step(
    'engine default is "ask": preflight needs a decision for a project with .pi resources',
    async () => {
      const cwd = await app.createWorkspace(projectFiles('preflight'))
      const preflight = await app.invoke('launch:trust-preflight', cwd)
      assert.equal(preflight.requiresTrust, true)
      assert.equal(preflight.needsDecision, true)
      assert.deepEqual(preflight.resources.map((r) => r.kind).sort(), ['extensions', 'skills'])
    }
  )

  await step(
    'Trust and remember: project tool + skill reach the model, trust.json saves true, no re-ask',
    async () => {
      const cwd = await app.createWorkspace(projectFiles('remember'))
      await openWithChoice(cwd, 'Trust and remember')
      assert.deepEqual(await probe('remember'), { tool: true, skill: true })
      assert.equal(await savedDecision(cwd), true, JSON.stringify(await trustJson()))
      assert.equal(await newSessionAsks(), false, 'second session in a trusted folder must not ask')
      assert.deepEqual(await probe('remember-2'), { tool: true, skill: true })
    }
  )

  await step(
    'Trust this time: loaded now, nothing saved, the next session asks again',
    async () => {
      const cwd = await app.createWorkspace(projectFiles('once'))
      await openWithChoice(cwd, 'Trust this time')
      assert.deepEqual(await probe('once'), { tool: true, skill: true })
      assert.equal(await savedDecision(cwd), undefined)
      assert.equal(await newSessionAsks(), true, 'next session asks again')
      await page.keyboard.press('Escape')
      await page.getByRole('textbox', { name: 'Message' }).first().waitFor()
    }
  )

  await step(
    'Don’t trust and remember: not loaded, trust.json saves false, no re-ask',
    async () => {
      const cwd = await app.createWorkspace(projectFiles('distrust'))
      await openWithChoice(cwd, 'Don’t trust and remember')
      assert.deepEqual(await probe('distrust'), { tool: false, skill: false })
      assert.equal(await savedDecision(cwd), false)
      assert.equal(await newSessionAsks(), false)
      assert.deepEqual(await probe('distrust-2'), { tool: false, skill: false })
    }
  )

  await step('Not now: not loaded, nothing saved, asks again', async () => {
    const cwd = await app.createWorkspace(projectFiles('notnow'))
    await openWithChoice(cwd, 'Not now')
    assert.deepEqual(await probe('notnow'), { tool: false, skill: false })
    assert.equal(await savedDecision(cwd), undefined)
    assert.equal(await newSessionAsks(), true)
    await page.keyboard.press('Escape')
    await page.getByRole('textbox', { name: 'Message' }).first().waitFor()
  })

  await step('Escape on the Trust dialog = Not now (not loaded, nothing saved)', async () => {
    const cwd = await app.createWorkspace(projectFiles('escape'))
    await openWithChoice(cwd, 'Escape')
    assert.deepEqual(await probe('escape'), { tool: false, skill: false })
    assert.equal(await savedDecision(cwd), undefined)
  })

  await step('keyboard: digit 1 picks "Trust and remember"', async () => {
    const cwd = await app.createWorkspace(projectFiles('digit'))
    const opening = app.test('openWorkspace', cwd)
    await page.getByRole('dialog', { name: /^Trust “/ }).waitFor({ timeout: 20_000 })
    await page.keyboard.press('1')
    await opening
    assert.equal(await savedDecision(cwd), true)
  })

  await step(
    'Project trust… (palette) re-decides: distrust + restart open session drops the tool',
    async () => {
      const cwd = (await app.appState()).prefs.activeWorkspace
      const agentId = await app.activeAgentId()
      await runPalette(page, 'Project trust', 'Project trust…')
      const dialog = page.getByRole('dialog', { name: /^Project trust for/ })
      await dialog.waitFor()
      await shot(page, 'trust-manage-dialog')
      await dialog.getByRole('option', { name: /^Don’t trust and remember/ }).click()
      await waitUntil(async () => (await savedDecision(cwd)) === false, { label: 'saved false' })
      await waitUntil(
        async () => {
          const state = await app.agentState(agentId)
          return (
            state?.status === 'ready' && state.info.args.approve === undefined && state.info.pid
          )
        },
        { timeoutMs: 30_000, label: 'restarted session' }
      )
      assert.deepEqual(await probe('managed'), { tool: false, skill: false })
    }
  )

  await step('no trust dialog for a folder without project resources', async () => {
    const cwd = await app.createWorkspace({ 'README.md': '# plain\n' })
    await app.test('openWorkspace', cwd)
    assert.equal(await page.getByRole('dialog', { name: /^Trust “/ }).count(), 0)
  })

  finish()
})
