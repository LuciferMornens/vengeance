import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { processTable } from '../lib/processes.mjs'
import { PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const WAIT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 50
const IMPORTED_SESSION_NAME = 'Engine2 imported sidebar session'
const CLOSED_PI_SESSION_NAME = 'Engine saved sidebar session'
const PEER_SESSION_NAME = 'Engine2 restart peer'
const RESTART_WITH_PEER_PROMPT = 'Engine2 target with a same-daemon peer. Reply briefly.'
const REJECTED_RESTART_PROMPT = 'This prompt must never replace the busy daemon configuration.'
const DETACHED_STREAM_TEXT = 'Engine2 streamed while its view was detached.'
const RELAUNCH_PROMPT = 'Keep this resident streaming during app relaunch'

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function activateSession(application, name) {
  await application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: name })
    .click()
  await application.composer()
}

async function detachSession(application, name) {
  const row = application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: name })
  await row.hover()
  await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
}

export async function checkSavedSidebar(
  application,
  primaryName,
  piAgentId,
  importedSessionFile,
  check
) {
  await check(
    'closed saved sessions from both engines appear once and reopen through the sidebar',
    async () => {
      assert.ok(importedSessionFile, 'the native import exists')
      await application.invoke('sessions:rename', importedSessionFile, IMPORTED_SESSION_NAME)
      const piState = await application.rpc({ type: 'get_state' }, piAgentId)
      const piTree = await application.rpc({ type: 'get_tree' }, piAgentId)
      const closedPiPath = await application.invoke('sessions:branch', {
        engine: 'pi',
        sessionPath: piState.sessionFile,
        entryId: piTree.leafId
      })
      await application.invoke('sessions:rename', closedPiPath, CLOSED_PI_SESSION_NAME)
      const nativeRow = application.page.locator('[data-session-row]', {
        hasText: IMPORTED_SESSION_NAME
      })
      const piRow = application.page.locator('[data-session-row]', {
        hasText: CLOSED_PI_SESSION_NAME
      })
      await nativeRow.waitFor({ timeout: WAIT_TIMEOUT_MS })
      await piRow.waitFor({ timeout: WAIT_TIMEOUT_MS })
      assert.equal(await nativeRow.count(), 1)
      assert.equal(await piRow.count(), 1)
      await application.screenshot('engines-saved-sidebar-workspace')
      await application.page.getByRole('button', { name: 'Switch workspace' }).click()
      await application.page.getByRole('button', { name: 'All workspaces', exact: true }).click()
      await nativeRow.waitFor({ timeout: WAIT_TIMEOUT_MS })
      assert.equal(
        await nativeRow.count(),
        1,
        'native session roots are deduplicated in all workspaces'
      )
      assert.equal(await piRow.count(), 1)
      await application.screenshot('engines-saved-sidebar-all-workspaces')
      await nativeRow.click()
      const resumedId = await until(async () => {
        const activeId = await application.activeAgentId()
        const active = activeId ? await application.agentState(activeId) : undefined
        if (active?.info.engine !== 'prime' || active.status !== 'ready') return undefined
        const state = await application.rpc({ type: 'get_state' }, activeId)
        return state.sessionFile?.toLowerCase() === importedSessionFile.toLowerCase()
          ? activeId
          : undefined
      }, 'native saved sidebar session reopened')
      const resumed = await application.rpc({ type: 'get_state' }, resumedId)
      assert.equal(resumed.sessionFile.toLowerCase(), importedSessionFile.toLowerCase())
      const messages = await application.rpc({ type: 'get_messages' }, resumedId)
      assert.ok(JSON.stringify(messages).includes('Engine2 concurrency probe'))
      const info = (await application.invoke('engine:list')).find(
        (agent) => agent.agentId === resumedId
      )
      await detachSession(application, IMPORTED_SESSION_NAME)
      await application.invoke('engine:background-stop', 'prime', info.nativeAgentId)
      await activateSession(application, primaryName)
    }
  )
}

export async function checkRestartPeer(
  application,
  server,
  workspace,
  targetId,
  primaryName,
  check
) {
  await check(
    'native restart reconnects an idle peer and rejects a busy peer without interruption',
    async () => {
      const peer = await application.openWorkspace({
        cwd: workspace,
        args: {
          engine: 'prime',
          provider: PRIME_PROVIDER,
          model: PRIME_MODELS.reasoning,
          thinking: 'off',
          name: PEER_SESSION_NAME
        }
      })
      server.queue(turn.text('The native peer keeps its saved history.'))
      await application.send('Remember the native peer history')
      await application.waitForSettle()
      const peerBefore = await application.rpc({ type: 'get_state' }, peer.agentId)
      const peerInfoBefore = (await application.invoke('engine:list')).find(
        (agent) => agent.agentId === peer.agentId
      )
      const targetInfo = (await application.invoke('engine:list')).find(
        (agent) => agent.agentId === targetId
      )
      const processes = await processTable()
      const peerProcess = processes.find((entry) => entry.pid === peerInfoBefore.pid)
      const targetProcess = processes.find((entry) => entry.pid === targetInfo.pid)
      assert.ok(peerProcess && targetProcess)
      assert.equal(peerProcess.ppid, targetProcess.ppid, 'both resident workers share one daemon')
      const peerMessagesBefore = await application.rpc({ type: 'get_messages' }, peer.agentId)
      // Activating the target starts history hydration, which correctly blocks its restart.
      try {
        await application.invoke('engine:restart', targetId, {
          thinking: 'medium',
          launch: { prime: { systemPrompt: RESTART_WITH_PEER_PROMPT } }
        })
        await until(
          async () => (await application.agentState(peer.agentId)).status === 'ready',
          'idle native peer reconnected'
        )
        const targetPrompt = await application.invoke(
          'prime:command',
          targetId,
          'get_system_prompt',
          {}
        )
        assert.ok(targetPrompt.systemPrompt.includes(RESTART_WITH_PEER_PROMPT))
        const peerAfter = await application.rpc({ type: 'get_state' }, peer.agentId)
        const peerInfoAfter = (await application.invoke('engine:list')).find(
          (agent) => agent.agentId === peer.agentId
        )
        assert.equal(peerInfoAfter.nativeAgentId, peerInfoBefore.nativeAgentId)
        assert.equal(peerAfter.sessionId, peerBefore.sessionId)
        assert.equal(peerAfter.thinkingLevel, peerBefore.thinkingLevel)
        assert.deepEqual(peerAfter.model, peerBefore.model)
        assert.deepEqual(
          await application.rpc({ type: 'get_messages' }, peer.agentId),
          peerMessagesBefore
        )
        const from = server.requests.length
        server.queue(turn.text('The native peer can prompt after restart.'))
        await application.rpc(
          { type: 'prompt', message: 'Peer prompt after restart' },
          peer.agentId
        )
        const request = await server.waitForRequest(
          (candidate) => inspectRequest(candidate).lastUserText === 'Peer prompt after restart',
          { from }
        )
        assert.equal(await server.waitForOutcome(request), 'completed')
        await until(
          async () => (await application.agentState(peer.agentId)).phase === 'idle',
          'native peer settled'
        )
        const busyFrom = server.requests.length
        server.queue(turn.hang({ text: 'Native restart peer is busy.' }))
        await application.rpc(
          { type: 'prompt', message: 'Busy peer restart rejection probe' },
          peer.agentId
        )
        const busyRequest = await server.waitForRequest(undefined, { from: busyFrom })
        await assert.rejects(
          application.invoke('engine:restart', targetId, {
            launch: { prime: { systemPrompt: REJECTED_RESTART_PROMPT } }
          }),
          /busy|running|streaming|idle|wait/i
        )
        assert.equal(busyRequest.outcome, 'streaming')
        const stillApplied = await application.invoke(
          'prime:command',
          targetId,
          'get_system_prompt',
          {}
        )
        assert.ok(stillApplied.systemPrompt.includes(RESTART_WITH_PEER_PROMPT))
        assert.ok(!stillApplied.systemPrompt.includes(REJECTED_RESTART_PROMPT))
        await application.rpc({ type: 'abort' }, peer.agentId)
        assert.equal(await server.waitForOutcome(busyRequest), 'aborted')
      } finally {
        await application.rpc({ type: 'abort' }, peer.agentId).catch(() => undefined)
        await detachSession(application, PEER_SESSION_NAME)
        await application.invoke('engine:background-stop', 'prime', peerInfoBefore.nativeAgentId)
        await activateSession(application, primaryName)
      }
    }
  )
}

export async function checkResidentReattach(application, server, options, check) {
  let agentId = options.agentId
  await check('detach and app relaunch reattach one resident with its transcript', async () => {
    const before = await application.rpc({ type: 'get_state' }, agentId)
    const nativeBefore = await application.invoke('prime:command', agentId, 'get_state', {})
    const residentsBefore = await application.invoke('engine:background-list', 'prime')
    const resident = residentsBefore.find(
      (item) => item.sessionPath?.toLowerCase() === options.sessionFile.toLowerCase()
    )
    assert.ok(resident, 'Engine2 resident is discoverable')
    const from = server.requests.length
    server.queue(
      turn.hang({
        text: DETACHED_STREAM_TEXT,
        when: (request) => inspectRequest(request).lastUserText === RELAUNCH_PROMPT
      })
    )
    await application.send(RELAUNCH_PROMPT)
    const request = await server.waitForRequest(
      (candidate) => inspectRequest(candidate).lastUserText === RELAUNCH_PROMPT,
      { from }
    )
    await until(
      async () => (await application.agentState(agentId)).phase === 'running',
      'resident streaming'
    )
    await detachSession(application, options.name)
    await until(
      async () =>
        !(await application.invoke('engine:list')).some((agent) => agent.agentId === agentId),
      'Engine2 detached'
    )
    const detached = await application.invoke('engine:background-list', 'prime')
    assert.equal(detached.filter((item) => item.id === resident.id).length, 1)
    application = await application.relaunch()
    options.onRelaunch(application)
    assert.equal(request.outcome, 'streaming', 'detached work survived app relaunch')
    const residentsAfter = await application.invoke('engine:background-list', 'prime')
    assert.equal(residentsAfter.filter((item) => item.id === resident.id).length, 1)
    await application.page
      .getByRole('button', { name: `Resume ${options.name}`, exact: true })
      .click()
    agentId = await until(async () => {
      const activeId = await application.activeAgentId()
      const active = activeId ? await application.agentState(activeId) : undefined
      if (active?.info.engine !== 'prime' || active.status !== 'ready') return undefined
      const state = await application.rpc({ type: 'get_state' }, activeId)
      return state.sessionFile?.toLowerCase() === options.sessionFile.toLowerCase()
        ? activeId
        : undefined
    }, 'streaming resident reattached')
    await until(
      async () => (await application.agentState(agentId)).phase === 'running',
      'busy snapshot restored'
    )
    const after = await application.rpc({ type: 'get_state' }, agentId)
    assert.equal(after.sessionId, before.sessionId)
    assert.ok(
      JSON.stringify((await application.agentState()).entries).includes(options.historyText)
    )
    const nativeAfter = await application.invoke('prime:command', agentId, 'get_state', {})
    assert.equal(nativeAfter.activeSessionId, resident.id)
    assert.equal(nativeAfter.goal?.objective, nativeBefore.goal?.objective)
    assert.equal(nativeAfter.goal?.status, nativeBefore.goal?.status)
    assert.equal(
      (await application.invoke('engine:background-list', 'prime')).filter(
        (item) => item.sessionPath?.toLowerCase() === options.sessionFile.toLowerCase()
      ).length,
      1
    )
    await application.screenshot('engine2-resident-reattached')
    await application.page.getByRole('button', { name: 'Stop', exact: true }).click()
    assert.equal(await server.waitForOutcome(request), 'aborted')
    await application.waitForSettle()
    assert.equal((await application.agentState()).phase, 'idle')
    await application.page.getByText(DETACHED_STREAM_TEXT, { exact: true }).waitFor()
    const settledMessages = await application.rpc({ type: 'get_messages' }, agentId)
    assert.ok(
      settledMessages.messages.some((message) => {
        const text =
          typeof message.content === 'string'
            ? message.content
            : (message.content ?? []).map((block) => block.text ?? '').join('')
        return text === DETACHED_STREAM_TEXT
      }),
      'the exact detached partial reply reconciles when the native turn settles'
    )
    await application.screenshot('engine2-resident-settled')
    await application.invoke('engine:background-stop', 'prime', resident.id)
    await until(
      async () =>
        !(await application.invoke('engine:background-list', 'prime')).some(
          (item) => item.id === resident.id
        ),
      'owned Engine2 resident stopped'
    )
  })
}
