import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { closeSettings, openSettings } from '../settings/settings-ui.mjs'
import { PRIME_HEADER_VALUE } from './integration-fixture.mjs'

const WAIT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 50
const GOAL_OBJECTIVE = 'Produce the isolated Engine2 goal proof'
const GOAL_TOKEN_BUDGET = 4000
const CHILD_TASK = 'Reply with exactly: Engine2 delegated answer'
const CHILD_NAME = 'qa-engine2-child'
const PARENT_TASK = 'Start the isolated Engine2 delegation probe'
const CHILD_FOLLOW_UP = 'Continue the isolated Engine2 child probe'
const CANCEL_CHILD_NAME = 'qa-engine2-cancel-child'
const CANCEL_CHILD_TASK = 'Keep the isolated child task running until cancellation'
const CANCEL_PARENT_TASK = 'Start the isolated Engine2 child cancellation probe'
const SUBAGENT_DEPTH = 1
const SCHEDULE_DELAY_MS = 2000
const OUTPUT_USAGE_TOKENS = 48
const COMPACT_WINDOW_SIZE = { width: 1024, height: 768 }
const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 }
const NOOP_REFINEMENT = {
  summary: 'The isolated transcript needs no durable edits.',
  rationale: 'This is a deterministic QA conversation.',
  expectedOutcome: 'Keep the local harness empty.',
  edits: []
}

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function nativeCommand(application, agentId, command, payload = {}) {
  return application.invoke('prime:command', agentId, command, payload)
}

async function openControls(application, section) {
  await application.page.getByRole('button', { name: 'Controls', exact: true }).click()
  await application.page.getByRole('tab', { name: section, exact: true }).click()
}

async function assertControlHasNoError(application) {
  const error = application.page
    .getByRole('dialog', { name: 'Engine 2 session controls' })
    .getByRole('alert')
  if (await error.isVisible().catch(() => false)) throw new Error(await error.innerText())
}

function latestAutonomy(messages) {
  return messages.messages.filter((message) => message.customType === 'autonomous_status').at(-1)
    ?.details
}

export async function checkNativeSubagents(
  application,
  server,
  agentId,
  checkStep,
  runtimeToolName
) {
  const toolName =
    runtimeToolName ??
    inspectRequest(server.requests[0]).tools.find((name) => name === 'ipython' || name === 'python')
  await checkStep(
    'native subagent controls message a resident and cancel an initial running task',
    async () => {
      server.reset()
      const primaryName = (await application.rpc({ type: 'get_state' }, agentId)).sessionName
      await openControls(application, 'Subagents')
      const depth = application.page.getByRole('textbox', { name: 'Maximum delegation depth' })
      await depth.fill(String(SUBAGENT_DEPTH))
      await depth.blur()
      await application.page.getByRole('button', { name: 'Apply', exact: true }).click()
      await until(async () => {
        const depthState = await nativeCommand(application, agentId, 'get_rlm_max_depth_status')
        return (depthState.maxDepth ?? depthState.effectiveMaxDepth) === SUBAGENT_DEPTH
      }, 'subagent depth applied')
      await application.page.keyboard.press('Escape')

      assert.ok(toolName, 'the model exposes the native Python runtime')
      const childArguments = [
        JSON.stringify(CHILD_TASK),
        `name=${JSON.stringify(CHILD_NAME)}`
      ].join(', ')
      const code = [
        'import rlm',
        `child = await rlm.spawn(${childArguments})`,
        'print(child.rlm_child_id)'
      ].join('\n')
      const delegationFrom = server.requests.length
      const parentRequest = (request) => inspectRequest(request).lastUserText === PARENT_TASK
      const childRequest = (request) => inspectRequest(request).lastUserText.includes(CHILD_TASK)
      server.queue(
        turn.toolCall(toolName, { code }, { when: parentRequest }),
        turn.text('Engine2 delegated answer', { when: childRequest }),
        turn.text('Engine2 admitted the delegated task.', { when: parentRequest })
      )
      await application.send(PARENT_TASK)
      await application.waitForSettle()
      const delegatedRequest = await server.waitForRequest(childRequest, {
        from: delegationFrom
      })
      assert.equal(await server.waitForOutcome(delegatedRequest), 'completed')
      const child = await until(async () => {
        const roster = await nativeCommand(application, agentId, 'get_rlm_children')
        return roster.children.find(
          (entry) => entry.sessionName === CHILD_NAME && entry.status === 'done'
        )
      }, 'initial native child task completed')
      assert.ok(child, 'the native child is discoverable through the public roster')
      assert.ok(child.activeSessionId)
      const background = await application.invoke('engine:background-list', 'prime')
      const childResident = background.find((entry) => entry.id === child.activeSessionId)
      assert.equal(childResident.lineage.childId, child.id)
      assert.equal(
        childResident.lineage.parentNativeAgentId,
        (await nativeCommand(application, agentId, 'get_state')).activeSessionId
      )
      await application.waitForSettle()
      const childLabel = child.label || child.sessionName || child.id
      await openControls(application, 'Subagents')
      await application.page
        .getByRole('button', { name: `Message ${childLabel}`, exact: true })
        .click()
      await application.page
        .getByRole('textbox', { name: `Message to ${childLabel}` })
        .fill(CHILD_FOLLOW_UP)
      const followUpFrom = server.requests.length
      const followUpRequest = (request) =>
        inspectRequest(request).lastUserText.includes(CHILD_FOLLOW_UP)
      server.queue(
        turn.hang({ text: 'Engine2 child is running a follow-up.', when: followUpRequest })
      )
      await application.page.getByRole('button', { name: 'Send message', exact: true }).click()
      const followUp = await server.waitForRequest(followUpRequest, { from: followUpFrom })
      await application.page.keyboard.press('Escape')
      const family = application.page.getByRole('button', {
        name: `Subagents of ${primaryName}`,
        exact: true
      })
      await family.waitFor()
      if ((await family.getAttribute('aria-expanded')) === 'false') await family.click()
      const nested = application.page.locator('[data-prime-subagent]', { hasText: CHILD_NAME })
      await nested.locator('[data-session-row]').click()
      const childAgentId = await until(async () => {
        const activeId = await application.activeAgentId()
        const active = activeId ? await application.agentState(activeId) : undefined
        if (active?.info.engine !== 'prime' || active.status !== 'ready') return undefined
        const state = await nativeCommand(application, activeId, 'get_state')
        return state.activeSessionId === child.activeSessionId ? activeId : undefined
      }, 'child resident conversation resumed')
      await application.page.getByRole('button', { name: 'Stop', exact: true }).click()
      assert.equal(await server.waitForOutcome(followUp), 'aborted')
      await application.waitForSettle()
      assert.equal((await application.agentState(childAgentId)).phase, 'idle')
      const childRow = nested.locator('[data-session-row]')
      assert.equal(
        await application.page
          .locator('section[aria-label="Background sessions"]')
          .getByRole('button', { name: `Resume ${CHILD_NAME}`, exact: true })
          .count(),
        0,
        'a delegated child is not an ordinary background session'
      )
      await childRow.hover()
      await childRow.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
      await application.page
        .locator('section[aria-label="Open sessions"]')
        .locator('[data-session-row]', { hasText: primaryName })
        .click()
      await openControls(application, 'Subagents')
      await application.page
        .getByRole('button', { name: `Delete ${childLabel}`, exact: true })
        .click()
      await application.page.getByRole('button', { name: 'Delete', exact: true }).click()
      await until(async () => {
        await assertControlHasNoError(application)
        const roster = await nativeCommand(application, agentId, 'get_rlm_children')
        return !roster.children.some((entry) => entry.id === child.id)
      }, 'completed native child deleted')
      await application.page.keyboard.press('Escape')

      const cancelArguments = [
        JSON.stringify(CANCEL_CHILD_TASK),
        `name=${JSON.stringify(CANCEL_CHILD_NAME)}`
      ].join(', ')
      const cancelCode = [
        'import rlm',
        `child = await rlm.spawn(${cancelArguments})`,
        'print(child.rlm_child_id)'
      ].join('\n')
      const cancellationFrom = server.requests.length
      const cancelParentRequest = (request) =>
        inspectRequest(request).lastUserText === CANCEL_PARENT_TASK
      const cancelChildRequest = (request) =>
        inspectRequest(request).lastUserText.includes(CANCEL_CHILD_TASK)
      server.queue(
        turn.toolCall(toolName, { code: cancelCode }, { when: cancelParentRequest }),
        turn.hang({ text: 'Engine2 initial child task is running.', when: cancelChildRequest }),
        turn.text('Engine2 admitted the cancellable task.', { when: cancelParentRequest })
      )
      await application.send(CANCEL_PARENT_TASK)
      const cancellableRequest = await server.waitForRequest(cancelChildRequest, {
        from: cancellationFrom
      })
      const cancellable = await until(async () => {
        const roster = await nativeCommand(application, agentId, 'get_rlm_children')
        return roster.children.find(
          (entry) => entry.sessionName === CANCEL_CHILD_NAME && entry.status === 'running'
        )
      }, 'initial native child task running')
      const cancelLabel = cancellable.label || cancellable.sessionName || cancellable.id
      await openControls(application, 'Subagents')
      await application.screenshot('engine2-native-subagents')
      await application.page
        .getByRole('button', { name: `Stop ${cancelLabel}`, exact: true })
        .click()
      assert.equal(await server.waitForOutcome(cancellableRequest), 'aborted')
      await until(async () => {
        await assertControlHasNoError(application)
        const roster = await nativeCommand(application, agentId, 'get_rlm_children')
        const current = roster.children.find((entry) => entry.id === cancellable.id)
        return current && !['running', 'queued'].includes(current.status)
      }, 'initial native child task cancelled')
      await application.page
        .getByRole('button', { name: `Delete ${cancelLabel}`, exact: true })
        .click()
      await application.page.getByRole('button', { name: 'Delete', exact: true }).click()
      await until(async () => {
        await assertControlHasNoError(application)
        const roster = await nativeCommand(application, agentId, 'get_rlm_children')
        return !roster.children.some((entry) => entry.id === cancellable.id)
      }, 'cancelled native child deleted')
      await application.page.keyboard.press('Escape')
      await application.waitForSettle()
    }
  )
}

export async function checkNativeControls(application, server, agentId, checkStep) {
  const runtimeToolName = inspectRequest(server.requests[0]).tools.find(
    (name) => name === 'ipython' || name === 'python'
  )
  const check = (label, action) =>
    checkStep(label, async () => {
      server.reset()
      await action()
    })
  await check('native service-tier slash actions change only the Engine2 session', async () => {
    const from = server.requests.length
    const composer = await application.composer()
    await composer.fill('/tier priority')
    await composer.press('Enter')
    const applied = await nativeCommand(application, agentId, 'get_state')
    assert.ok(['priority', 'default'].includes(applied.serviceTier))
    await composer.fill('/fast off')
    await composer.press('Enter')
    await until(
      async () =>
        (await nativeCommand(application, agentId, 'get_state')).serviceTier === 'default',
      'default service tier'
    )
    assert.equal(server.requests.length, from, 'native service-tier settings do not prompt a model')
  })

  await check('native goal form starts a budgeted goal and pauses its continuation', async () => {
    const from = server.requests.length
    server.queue(turn.hang({ text: 'Engine2 goal work is running.' }))
    await openControls(application, 'Goal')
    await application.page.getByRole('textbox', { name: 'Goal objective' }).fill(GOAL_OBJECTIVE)
    const budget = application.page.getByRole('textbox', { name: 'Goal token budget' })
    await budget.fill(String(GOAL_TOKEN_BUDGET))
    await budget.blur()
    await application.page.getByRole('button', { name: 'Start goal', exact: true }).click()
    const goal = await until(async () => {
      await assertControlHasNoError(application)
      const state = await nativeCommand(application, agentId, 'get_state')
      return state.goal?.objective === GOAL_OBJECTIVE ? state.goal : undefined
    }, 'native goal creation')
    assert.equal(goal.tokenBudget, GOAL_TOKEN_BUDGET)
    const request = await server.waitForRequest(undefined, { from })
    await application.page.getByRole('button', { name: 'Pause goal', exact: true }).click()
    await until(
      async () =>
        (await nativeCommand(application, agentId, 'get_state')).goal?.status === 'paused',
      'native goal paused'
    )
    assert.equal(await server.waitForOutcome(request), 'aborted')
    await application.screenshot('engine2-native-goal')
    await application.page.keyboard.press('Escape')
    await application.waitForSettle()
  })

  await check('native autonomous controls enable a bounded run and turn it off', async () => {
    await openControls(application, 'Autonomy')
    server.queue(turn.hang({ text: 'Engine2 bounded autonomous work is running.' }))
    await application.rpc({ type: 'prompt', message: '/autonomous on --max-turns 1' }, agentId)
    await application.rpc({ type: 'prompt', message: '/autonomous status' }, agentId)
    await until(async () => {
      const messages = await nativeCommand(application, agentId, 'get_messages')
      return latestAutonomy(messages)?.enabled === true
    }, 'autonomous execution enabled')
    await application.screenshot('engine2-native-autonomy')
    await application.page.getByRole('button', { name: 'Turn off', exact: true }).click()
    await application.rpc({ type: 'prompt', message: '/autonomous status' }, agentId)
    await until(async () => {
      const messages = await nativeCommand(application, agentId, 'get_messages')
      return latestAutonomy(messages)?.enabled === false
    }, 'autonomous execution disabled')
    await application.page.keyboard.press('Escape')
    await application.rpc({ type: 'abort' }, agentId)
  })

  await check('native refinement uses the fake provider and returns a no-op plan', async () => {
    const from = server.requests.length
    server.queue(turn.text(JSON.stringify(NOOP_REFINEMENT)))
    await openControls(application, 'Refine')
    await application.page
      .getByRole('textbox', { name: 'Refinement instructions' })
      .fill('Inspect this QA transcript without changing durable entries.')
    await application.page.getByRole('button', { name: 'Refine now', exact: true }).click()
    await until(async () => {
      await assertControlHasNoError(application)
      return application.page.getByText('Refinement finished.', { exact: true }).isVisible()
    }, 'native refinement result')
    const request = await server.waitForRequest(undefined, { from })
    assert.equal(await server.waitForOutcome(request), 'completed')
    assert.ok(inspectRequest(request).system.length > 0)
    await application.screenshot('engine2-native-refinement')
    await application.page.keyboard.press('Escape')
  })

  await checkNativeSubagents(application, server, agentId, checkStep, runtimeToolName)

  await check('native scheduled prompts fire through the fake provider', async () => {
    const prompt = 'Engine2 one-shot schedule delivery probe'
    const from = server.requests.length
    server.queue(turn.text('Engine2 delivered the scheduled prompt.'))
    const schedule = `at ${new Date(Date.now() + SCHEDULE_DELAY_MS).toISOString()}`
    await nativeCommand(application, agentId, 'cron_add', { schedule, prompt })
    const request = await server.waitForRequest(
      (candidate) => inspectRequest(candidate).lastUserText.includes(prompt),
      { from }
    )
    assert.equal(await server.waitForOutcome(request), 'completed')
    await application.waitForSettle()
  })

  await check(
    'native side questions stream independently through their public controls',
    async () => {
      const from = server.requests.length
      const before = await application.rpc({ type: 'get_state' }, agentId)
      server.queue(turn.text('Engine2 side answer.'))
      await openControls(application, 'Side question')
      await application.page
        .getByRole('textbox', { name: 'Side question' })
        .fill('Reply with a short side answer')
      await application.page.getByRole('button', { name: 'Ask side question', exact: true }).click()
      await application.page.getByText('Engine2 side answer.', { exact: true }).waitFor({
        timeout: WAIT_TIMEOUT_MS
      })
      const request = await server.waitForRequest(undefined, { from })
      assert.equal(await server.waitForOutcome(request), 'completed')
      assert.equal(
        (await application.rpc({ type: 'get_state' }, agentId)).messageCount,
        before.messageCount
      )
      await application.screenshot('engine2-native-side-question')
      await application.page.keyboard.press('Escape')
    }
  )

  await check('native factory controls display their required runtime configuration', async () => {
    await openControls(application, 'Factory')
    await application.page.getByRole('textbox', { name: 'Factory specification ID' }).waitFor()
    assert.equal(
      await application.page.getByRole('button', { name: 'Start factory run' }).isEnabled(),
      false
    )
    await application.screenshot('engine2-native-factory')
    await application.page.keyboard.press('Escape')
  })

  await check(
    'Engine2 token speed uses reported provider usage and can be turned off',
    async () => {
      const composer = await application.composer()
      await composer.fill('/speed on')
      await composer.press('Enter')
      server.queue(
        turn.text('Engine2 token speed answer.', {
          chunkSize: 1,
          delayMs: POLL_INTERVAL_MS,
          usage: { output: OUTPUT_USAGE_TOKENS }
        })
      )
      await application.send('Reply briefly for the token speed probe')
      await application.waitForSettle()
      const readout = application.page.getByRole('button', { name: 'Turn off token speed display' })
      assert.ok((await readout.innerText()).includes('tok/s'))
      await application.screenshot('engine2-token-speed-footer')
      await readout.click()
      assert.equal(await readout.count(), 0)
    }
  )

  await check(
    'native trace status and preview stay readonly and render at two window sizes',
    async () => {
      const cwd = (await application.agentState(agentId)).info.cwd
      const status = await application.invoke('engine:traces', { agentId, cwd, action: 'status' })
      assert.equal(status.enabled, false)
      const preview = await application.invoke('engine:traces', { agentId, cwd, action: 'preview' })
      assert.equal(preview.status, 'ready', preview.message)
      assert.ok(preview.preview.contentPreview)
      assert.ok(!JSON.stringify(preview).includes(PRIME_HEADER_VALUE))
      await openControls(application, 'Traces')
      await application.page
        .getByRole('button', { name: 'Preview current session', exact: true })
        .click()
      await application.page.getByText('Current session preview', { exact: true }).waitFor()
      await application.screenshot('engine2-native-traces-wide')
      try {
        await application.app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
        }, COMPACT_WINDOW_SIZE)
        await application.screenshot('engine2-native-traces-compact')
      } finally {
        await application.app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
        }, DEFAULT_WINDOW_SIZE)
        await application.page.keyboard.press('Escape')
      }
    }
  )

  await check('native settings and controls render in Obsidian and Bone', async () => {
    await openSettings(application)
    await application.page.getByRole('combobox', { name: 'Settings engine' }).click()
    await application.page.getByRole('option', { name: 'Engine 2', exact: true }).click()
    await openSettings(application, 'Agent behavior')
    await application.screenshot('engine2-settings-agent-obsidian')
    await openSettings(application, 'Providers & accounts')
    await application.screenshot('engine2-settings-providers')
    await openSettings(application, 'MCP servers')
    await application.screenshot('engine2-settings-mcp')
    await application.page.getByRole('button', { name: 'Add server', exact: true }).click()
    await application.screenshot('engine2-settings-mcp-editor')
    await application.page.keyboard.press('Escape')
    await openSettings(application, 'General')
    await application.page.getByRole('button', { name: 'Bone', exact: true }).click()
    await openSettings(application, 'Agent behavior')
    await application.screenshot('engine2-settings-agent-bone')
    await closeSettings(application)
    await openControls(application, 'Context')
    await application.screenshot('engine2-native-context-bone')
    await application.page.keyboard.press('Escape')
    await openSettings(application, 'General')
    await application.page.getByRole('button', { name: 'Obsidian', exact: true }).click()
    await application.page.getByRole('combobox', { name: 'Settings engine' }).click()
    await application.page.getByRole('option', { name: 'Engine', exact: true }).click()
    await openSettings(application, 'Models')
    await application.screenshot('engine-settings-models-isolated')
    await closeSettings(application)
  })
}
