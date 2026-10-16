import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FULL_WINDOW_SIZE = { width: 1440, height: 900 }
const NARROW_WINDOW_SIZE = { width: 880, height: 760 }
const SETTINGS_READY_TIMEOUT_MS = 15_000
const GOAL_OBJECTIVE = 'Review the release changes, fix regressions, and verify the build.'
const HEARTBEAT_INSTRUCTIONS = 'Check the release verification and report meaningful changes.'
const RECURRING_INSTRUCTIONS = 'Review unresolved release checks and summarize the next action.'
const FACTORY_SPECIFICATION = 'release-check'

function invoke(page, channel, ...args) {
  return page.evaluate(
    ([name, parameters]) => window.vengeance.invoke(name, ...parameters),
    [channel, args]
  )
}

function settingsRequest(page, engine, channel, ...args) {
  return invoke(page, 'engine:settings', { engine, channel, args })
}

async function chooseSettingsEngine(page, engineLabel) {
  await page.getByRole('combobox', { name: 'Settings engine' }).click()
  await page
    .getByRole('option')
    .filter({ has: page.getByText(engineLabel, { exact: true }) })
    .click()
}

async function setWindowSize(app, size) {
  await app.evaluate(({ BrowserWindow }, dimensions) => {
    BrowserWindow.getAllWindows()[0].setContentSize(dimensions.width, dimensions.height)
  }, size)
}

async function selectControlTab(controls, name) {
  const tab = controls.getByRole('tab', { name, exact: true })
  await tab.scrollIntoViewIfNeeded()
  await tab.click()
}

async function configureNativeSettings(page, cwd, resourceDirectory) {
  const skillDirectory = join(resourceDirectory, 'release-review')
  const promptPath = join(resourceDirectory, 'release-review.md')
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: release-review\ndescription: Review release changes and their verification.\n---\n' +
      'Inspect the release changes and report concrete regressions.\n',
    'utf8'
  )
  await writeFile(
    promptPath,
    '---\ndescription: Prepare the release verification checklist.\n---\n' +
      'Summarize the release checks that still need attention.\n',
    'utf8'
  )
  const values = {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultThinkingLevel: 'high',
    defaultServiceTier: 'default',
    rlmMaxDepth: 4,
    'factory.enabled': true,
    'autonomous.maxTurns': 12,
    'compaction.enabled': true,
    idleEvictionMinutes: 20,
    sessionArchiveMaxAgeDays: 30,
    'terminal.fullscreenMouse': true,
    skills: [skillDirectory],
    prompts: [promptPath],
    mcpServers: {
      documentation: {
        type: 'http',
        url: 'https://documentation.example.invalid/mcp',
        enabled: false,
        enabledTools: ['search', 'read_page'],
        startupTimeoutMs: 10_000,
        callTimeoutMs: 30_000
      }
    }
  }
  for (const [key, value] of Object.entries(values)) {
    await settingsRequest(page, 'prime', 'settings:set', {
      scope: 'global',
      cwd,
      path: key.split('.'),
      value
    })
  }
  await settingsRequest(page, 'prime', 'settings:models-json-write', {
    providers: {
      openai: {
        models: [
          {
            id: 'release-reviewer',
            name: 'Release reviewer',
            api: 'openai-responses',
            baseUrl: 'https://review.example.invalid/v1',
            contextWindow: 200_000,
            maxTokens: 16_000,
            reasoning: true,
            input: ['text'],
            thinkingLevelMap: { low: null, high: 'high' },
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }
          }
        ]
      }
    }
  })
}

export async function scenarios(page, { app, shot, test, tempDir }) {
  const cwd = await tempDir('native-workspace-')
  await writeFile(join(cwd, 'README.md'), '# Native Engine workspace\n', 'utf8')
  await test('setPrefs', {
    theme: 'dark',
    workspaces: [{ path: cwd, name: 'Release workspace', lastOpenedAt: Date.now() }],
    activeWorkspace: cwd,
    onboardingCompleted: true
  })
  await test('openWorkspace', cwd, { engine: 'pi', approve: true })
  const primaryAgent = await test('agentState')
  const primaryBefore = await settingsRequest(page, 'pi', 'settings:snapshot', cwd)
  await configureNativeSettings(page, cwd, await tempDir('native-resources-'))
  await test('openWorkspace', cwd, { engine: 'prime' })
  const nativeAgent = await test('agentState')
  assert.equal(nativeAgent.info.engine, 'prime')
  assert.equal((await test('agentState', primaryAgent.info.agentId)).info.engine, 'pi')

  await test('openSettings', 'models')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await chooseSettingsEngine(page, 'Engine 2')
  await settings.locator('[id="setting-defaultServiceTier"]').waitFor()
  await shot('prime-engine-settings-models-dark')
  await settings.getByRole('button', { name: 'Agent behavior', exact: true }).click()
  await settings.locator('[id="setting-factory.enabled"]').waitFor()
  await shot('prime-engine-settings-agent-dark')
  const compaction = settings.locator('[id="setting-compaction.enabled"]')
  await compaction.scrollIntoViewIfNeeded()
  await compaction.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Off', exact: true }).click()
  await page.waitForFunction(
    async (workspace) => {
      const snapshot = await window.vengeance.invoke('engine:settings', {
        engine: 'prime',
        channel: 'settings:snapshot',
        args: [workspace]
      })
      return snapshot.global.data.compaction?.enabled === false
    },
    cwd,
    { timeout: SETTINGS_READY_TIMEOUT_MS }
  )
  const primaryAfter = await settingsRequest(page, 'pi', 'settings:snapshot', cwd)
  assert.deepEqual(primaryAfter.global.data, primaryBefore.global.data)
  await chooseSettingsEngine(page, 'Engine')
  await settings.locator('[id="setting-steeringMode"]').waitFor()
  assert.equal(await settings.locator('[id="setting-factory.enabled"]').count(), 0)
  await shot('prime-engine-settings-switch-to-engine')
  await chooseSettingsEngine(page, 'Engine 2')
  await settings.locator('[id="setting-factory.enabled"]').waitFor()

  for (const [section, readyKey] of [
    ['Sessions & context', 'idleEvictionMinutes'],
    ['Terminal mode', 'terminal.fullscreenMouse']
  ]) {
    await settings.getByRole('button', { name: section, exact: true }).click()
    await settings.locator(`[id="setting-${readyKey}"]`).waitFor()
    await shot(
      `prime-engine-settings-${section.startsWith('Sessions') ? 'sessions' : 'terminal'}-dark`
    )
  }
  await settings.getByRole('button', { name: 'Resources', exact: true }).click()
  await settings
    .getByRole('switch', { name: /Enable release-review/ })
    .first()
    .waitFor()
  await shot('prime-engine-settings-resources-dark')
  await settings.getByRole('button', { name: 'Custom models', exact: true }).click()
  const advancedModel = settings.getByRole('button', {
    name: 'Advanced model settings for release-reviewer',
    exact: true
  })
  await advancedModel.waitFor()
  await advancedModel.click()
  await settings.getByText('Thinking level mapping', { exact: true }).scrollIntoViewIfNeeded()
  await shot('prime-engine-settings-custom-model-fields-dark')
  await settings.getByText('Compatibility', { exact: true }).last().scrollIntoViewIfNeeded()
  await shot('prime-engine-settings-custom-model-compat-dark')
  await settings.getByRole('button', { name: 'MCP servers', exact: true }).click()
  await settings.getByRole('button', { name: 'Edit documentation', exact: true }).waitFor()
  await shot('prime-engine-settings-mcp-dark')
  await settings.getByRole('button', { name: 'Edit documentation', exact: true }).click()
  const mcpEditor = page.getByRole('dialog', { name: 'Edit documentation', exact: true })
  await mcpEditor.getByRole('textbox', { name: 'Server URL' }).waitFor()
  await shot('prime-engine-settings-mcp-editor-dark')
  await mcpEditor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await test('setPrefs', { theme: 'light' })
  await settings.getByRole('button', { name: 'Agent behavior', exact: true }).click()
  await settings.locator('[id="setting-factory.enabled"]').waitFor()
  await shot('prime-engine-settings-agent-bone')
  await setWindowSize(app, NARROW_WINDOW_SIZE)
  await shot('prime-engine-settings-agent-narrow-bone')
  await setWindowSize(app, FULL_WINDOW_SIZE)
  await test('closeSettings')
  await test('setPrefs', { theme: 'dark' })

  await page.getByRole('button', { name: /^(?:Engine controls|Controls)$/ }).click()
  const controls = page.getByRole('dialog', { name: 'Engine 2 session controls', exact: true })
  await controls.getByRole('textbox', { name: 'Goal objective' }).fill(GOAL_OBJECTIVE)
  await shot('prime-engine-goal-editor-dark')
  await controls.getByRole('button', { name: 'Start goal', exact: true }).click()
  await controls.getByRole('heading', { name: 'Current goal', exact: true }).waitFor()
  await shot('prime-engine-goal-active-dark')
  await controls.getByRole('button', { name: 'Pause goal', exact: true }).click()
  await page.waitForFunction(async (agentId) => {
    const state = await window.vengeance.invoke('prime:command', agentId, 'get_state', {})
    return state.goal.status === 'paused'
  }, nativeAgent.info.agentId)
  await shot('prime-engine-goal-paused-dark')
  await controls.getByRole('button', { name: 'Clear goal', exact: true }).click()
  await selectControlTab(controls, 'Autonomy')
  await controls.getByRole('button', { name: 'Enable autonomous execution', exact: true }).click()
  await controls.getByRole('button', { name: 'Refresh status', exact: true }).click()
  await shot('prime-engine-autonomy-dark')

  await selectControlTab(controls, 'Schedule')
  await controls
    .getByRole('textbox', { name: 'Scheduled instructions' })
    .fill(HEARTBEAT_INSTRUCTIONS)
  await controls.getByRole('button', { name: 'Create heartbeat', exact: true }).click()
  await controls.getByRole('button', { name: 'Pause heartbeat', exact: true }).waitFor()
  await controls
    .getByRole('button', { name: 'Pause heartbeat', exact: true })
    .scrollIntoViewIfNeeded()
  await shot('prime-engine-heartbeat-dark')
  await controls.getByRole('combobox').filter({ hasText: 'Session heartbeat' }).click()
  await page.getByRole('option', { name: 'Recurring prompt', exact: true }).click()
  await controls
    .getByRole('textbox', { name: 'Scheduled instructions' })
    .fill(RECURRING_INSTRUCTIONS)
  await controls.getByRole('button', { name: 'Add scheduled prompt', exact: true }).click()
  await controls.getByRole('button', { name: 'Cancel scheduled prompt', exact: true }).waitFor()
  await controls
    .getByRole('button', { name: 'Cancel scheduled prompt', exact: true })
    .scrollIntoViewIfNeeded()
  await shot('prime-engine-schedules-dark')

  await selectControlTab(controls, 'Subagents')
  await controls.getByRole('textbox', { name: 'Maximum delegation depth' }).waitFor()
  await shot('prime-engine-subagents-dark')
  await selectControlTab(controls, 'Factory')
  await controls
    .getByRole('textbox', { name: 'Factory specification ID' })
    .fill(FACTORY_SPECIFICATION)
  await controls.getByRole('button', { name: 'Preview specification', exact: true }).click()
  await controls.getByRole('columnheader', { name: 'Stage', exact: true }).first().waitFor()
  await shot('prime-engine-factory-preview-dark')
  await controls.getByRole('button', { name: 'Start factory run', exact: true }).click()
  await controls.getByText('Factory run started.', { exact: true }).waitFor()
  await controls
    .getByRole('button', { name: 'Read status', exact: true })
    .last()
    .scrollIntoViewIfNeeded()
  await shot('prime-engine-factory-running-dark')
  await selectControlTab(controls, 'Traces')
  await controls.getByRole('button', { name: 'Preview current session', exact: true }).click()
  await controls.getByRole('heading', { name: 'Current session preview', exact: true }).waitFor()
  await controls
    .getByRole('columnheader', { name: 'Content types', exact: true })
    .scrollIntoViewIfNeeded()
  await shot('prime-engine-traces-preview-dark')
  await controls.getByRole('button', { name: 'Show trace content', exact: true }).click()
  await controls
    .getByText(/The workspace checks passed\. The session is ready to review\./)
    .waitFor()
  assert.equal(await controls.getByText(/mock-private-key/).count(), 0)
  await test('setPrefs', { theme: 'light' })
  await setWindowSize(app, NARROW_WINDOW_SIZE)
  await controls.locator('[aria-label="Trace content preview"]').scrollIntoViewIfNeeded()
  await shot('prime-engine-traces-preview-narrow-bone')
  await setWindowSize(app, FULL_WINDOW_SIZE)
  await selectControlTab(controls, 'Context')
  await controls.getByRole('checkbox', { name: /Token speed in composer/ }).click()
  await controls.getByRole('heading', { name: 'System prompt', exact: true }).waitFor()
  await shot('prime-engine-context-bone')
  await page.keyboard.press('Escape')
  await test('mockPlay', {
    script: 'short',
    prompt: 'Summarize the release checks.',
    instant: false
  })
  await test('waitForIdle')
  await page.getByRole('button', { name: 'Turn off token speed display', exact: true }).waitFor()
  await shot('prime-engine-token-speed-bone')
  assert.equal((await test('agentState', primaryAgent.info.agentId)).info.engine, 'pi')
  await speedScenarios(page, { shot, test })
}

/** Engine 2 response speed across supported and unavailable providers. */
async function speedScenarios(page, { shot, test }) {
  const composer = page.locator('[data-composer]')
  /** Pills at rest: no hover, no focus ring or tooltip left by the menu that just closed. */
  const settle = async () => {
    await page.mouse.move(760, 300)
    await page.evaluate(() => document.activeElement?.blur())
  }
  /** Pick `provider/id` by its row (not the first search hit), then wait for the footer to show it. */
  const chooseModel = async (value, name) => {
    await composer.getByRole('button', { name: /^Model:/ }).click()
    await page.getByPlaceholder('Search models…').fill(name)
    await page.locator(`[cmdk-item][data-value="${value}"]`).click()
    await composer.locator(`button[aria-label="Model: ${name}"]`).waitFor()
    await settle()
  }

  await test('setPrefs', { theme: 'dark' })
  await chooseModel('openrouter/openai/gpt-5.5', 'GPT-5.5 (OpenRouter)')
  await composer.locator('button[aria-label="Speed: Standard"]').click()
  await page.getByRole('menuitemradio', { name: /^Fast/ }).click()
  await composer.locator('button[aria-label="Speed: Fast"]').waitFor()
  const state = await page.evaluate(
    (agentId) => window.vengeance.invoke('prime:command', agentId, 'get_state', {}),
    await page.evaluate(() => window.__vengeanceTest.activeAgentId())
  )
  assert.equal(state.serviceTier, 'priority')
  await settle()
  await shot('prime-engine-speed-fast-dark', { settleMs: 400 })

  await chooseModel('openai/gpt-5.5', 'GPT-5.5')
  await composer.locator('button[aria-label="Speed: Fast"]').waitFor()
  await shot('prime-engine-speed-openai-fast-dark', { settleMs: 400 })

  await chooseModel('openai/gpt-6.1-sol', 'GPT-6.1 Sol')
  await composer.locator('button[aria-label="Speed: Fast"]').click()
  await page.getByRole('menuitemradio', { name: /^Ultrafast/ }).click()
  await composer.locator('button[aria-label="Speed: Ultrafast"]').waitFor()
  await settle()
  await shot('prime-engine-speed-ultrafast-dark', { settleMs: 400 })

  await chooseModel('anthropic/claude-opus-5-5', 'Claude Opus 5.5')
  const unavailable = composer.locator('button[aria-label^="Speed: Unavailable"]')
  await unavailable.hover()
  await page.getByRole('tooltip').waitFor()
  await shot('prime-engine-speed-unavailable-dark', { settleMs: 300 })
}
