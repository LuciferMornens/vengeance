import type { AppPersistedState } from '@shared/api/app'
import type {
  BackgroundAgentInfo,
  CreateAgentArgs,
  EngineId,
  MockPlayArgs
} from '@shared/api/engine'
import { closeAgent, openSessionFile, resumeBackgroundAgent } from '../features/sessions/actions'
import { openWorkspace } from '../features/shell/workspace'
import type { AgentState } from '../store/agent-state'
import { useAgents } from '../store/agents'
import { useApp, type AppStore } from '../store/app'
import { invoke } from './ipc'

/**
 * Deterministic driver for screenshot/E2E harnesses (installed only when VENGEANCE_TEST=1).
 * Use from Playwright: `await page.evaluate(() => window.__vengeanceTest!.openWorkspace('C:\\x'))`.
 */
export interface VengeanceTestHook {
  /** Open a workspace and start a session; resolves with the agent id once the engine is ready. */
  openWorkspace(path: string, args?: Partial<CreateAgentArgs>): Promise<string>
  openSession(path: string, engine: EngineId): Promise<string | null>
  resumeBackground(resident: BackgroundAgentInfo): Promise<void>
  closeSession(agentId: string): Promise<void>
  /** Mock mode: drive a scripted run on the active agent. Resolves once the run reached `pauseAt` (or settled). */
  mockPlay(args: MockPlayArgs): Promise<void>
  /** Answer the active agent's first pending extension dialog (default: first option / confirm / empty). */
  answerDialog(value?: string): Promise<void>
  /** Wait until the active agent is idle (agent_settled). */
  waitForIdle(timeoutMs?: number): Promise<void>
  /** Concatenated text of all assistant text blocks of the active agent. */
  assistantText(): string
  setPrefs(patch: Partial<AppPersistedState>): void
  openSettings(section?: string): void
  closeSettings(): void
  setPalette(open: boolean): void
  activeAgentId(): string | null
  /** JSON snapshot of an agent's store state (default: the active agent); null when unknown. */
  agentState(agentId?: string): AgentState | null
  /** JSON snapshot of the app store's data (persisted prefs and transient UI state). */
  appState(): Pick<AppStore, 'prefs' | 'ui'>
}

/** Plain-data copy that crosses into Playwright and cannot alias live store objects. */
function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`Timed out waiting for ${label}`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** Resolves once no engine event has arrived for `quietMs`. */
function waitForQuiet(quietMs = 300, timeoutMs = 30_000): Promise<void> {
  let last = -1
  let since = Date.now()
  return waitFor(
    () => {
      const marker = active()?.lastEventAt ?? 0
      if (marker !== last) {
        last = marker
        since = Date.now()
      }
      return Date.now() - since >= quietMs
    },
    timeoutMs,
    'quiet engine'
  )
}

function active() {
  const { activeAgentId, agents } = useAgents.getState()
  return activeAgentId ? agents[activeAgentId] : undefined
}

export function installTestHook(): void {
  window.__vengeanceTest = {
    openSession: (path, engine) => openSessionFile(path, { engine }),
    resumeBackground: (resident) => resumeBackgroundAgent(resident),
    closeSession: (agentId) => closeAgent(agentId),
    async openWorkspace(path, args) {
      const id = await openWorkspace(path, args)
      if (!id) throw new Error('Could not open workspace')
      await waitFor(
        () =>
          useAgents.getState().agents[id]?.status === 'ready' &&
          !!useAgents.getState().agents[id]?.session,
        120_000,
        'engine ready'
      )
      return id
    },
    async mockPlay(args) {
      const agent = active()
      if (!agent) throw new Error('No active agent')
      const before = agent.entries.length
      const progressed = () => {
        const a = active()
        return !!a && (a.entries.length > before || a.ext.dialogs.length > 0)
      }
      await invoke('mock:play', agent.id, args)
      if (args.pauseAt) {
        // A paused run stops emitting: wait until the stream has been quiet for a poll interval.
        let last = -1
        await waitFor(
          () => {
            const a = active()
            const marker = (a?.lastEventAt ?? 0) + (a?.entries.length ?? 0)
            const quiet = marker === last && progressed()
            last = marker
            return quiet
          },
          30_000,
          'mock pause'
        )
      } else {
        // Settled, or blocked on an extension dialog.
        await waitFor(
          () =>
            progressed() && (active()?.phase === 'idle' || (active()?.ext.dialogs.length ?? 0) > 0),
          120_000,
          'mock run'
        )
      }
    },
    async answerDialog(value) {
      await waitFor(() => (active()?.ext.dialogs.length ?? 0) > 0, 10_000, 'extension dialog')
      const agent = active()!
      const { request } = agent.ext.dialogs[0]!
      const response =
        request.method === 'confirm'
          ? { type: 'extension_ui_response' as const, id: request.id, confirmed: value !== 'no' }
          : {
              type: 'extension_ui_response' as const,
              id: request.id,
              value: value ?? (request.method === 'select' ? (request.options[0] ?? '') : '')
            }
      await useAgents.getState().respondUi(agent.id, response)
      await waitForQuiet()
    },
    async waitForIdle(timeoutMs = 120_000) {
      await waitFor(() => active()?.phase === 'idle', timeoutMs, 'idle')
    },
    assistantText() {
      const agent = active()
      if (!agent) return ''
      return agent.entries
        .flatMap((e) => (e.message.role === 'assistant' ? e.message.content : []))
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('\n')
    },
    setPrefs: (patch) => useApp.getState().update(patch),
    openSettings: (section) => useApp.getState().openSettings(section),
    closeSettings: () => useApp.getState().closeSettings(),
    setPalette: (open) => useApp.getState().setPaletteOpen(open),
    activeAgentId: () => useAgents.getState().activeAgentId,
    agentState(agentId) {
      const agent = agentId ? useAgents.getState().agents[agentId] : active()
      return agent ? snapshot(agent) : null
    },
    appState() {
      const { prefs, ui } = useApp.getState()
      return snapshot({ prefs, ui })
    }
  }
}
