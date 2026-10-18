import { ENGINE_LABELS } from '@shared/api/engine'
import type { Model, RpcCommandType, ThinkingLevel } from '@shared/engine-types'
import { bridge } from '../../lib/bridge'
import { rpc } from '../../lib/engine'
import { basename, formatTokens } from '../../lib/format'
import { invoke, on } from '../../lib/ipc'
import { REVEAL_LABEL } from '../../lib/platform-copy'
import { useAgents, withModelChange } from '../../store/agents'
import { toast } from '../../ui'
import { providerLabel } from '../chat/ModelPicker'
import { openPalette } from '../palette/store'
import { getEffectiveSetting } from '../settings/effective'
import { supportsEngineCommand } from '../engines/registry'
import { focusComposer, useDrafts } from './drafts'
import { fuzzyMatch } from './fuzzy'
import { previousInCycle } from './model-scope'
import { drainQueue } from './queue'

/**
 * Session operations that are a single engine RPC round trip. Shared by the composer's slash commands,
 * registered palette actions and hotkeys.
 */

export function activeAgentId(): string | null {
  return useAgents.getState().activeAgentId
}

export function supportsAgentCommand(agentId: string, command: RpcCommandType): boolean {
  const agent = useAgents.getState().agents[agentId]
  return !!agent && supportsEngineCommand(agent.info.engine, command)
}

function requireCommand(agentId: string, command: RpcCommandType): boolean {
  if (supportsAgentCommand(agentId, command)) return true
  const engine = useAgents.getState().agents[agentId]?.info.engine ?? 'pi'
  toast({ level: 'info', title: `This action is unavailable in ${ENGINE_LABELS[engine]}` })
  return false
}

function fail(title: string, error: unknown): void {
  toast({
    level: 'error',
    title,
    description: error instanceof Error ? error.message : String(error)
  })
}

/**
 * The Engine first aborts the current run and waits for it to end, then announces the compaction (the transcript
 * shows its progress from then on). A compact that has not started by now is stuck on that run.
 */
const COMPACT_START_GRACE_MS = 15_000

/** Refusals the Engine reports as errors, though nothing went wrong: the conversation needs no compaction. */
const NOTHING_TO_COMPACT: Array<{ pattern: RegExp; title: string; description: string }> = [
  {
    pattern: /Nothing to compact/i,
    title: 'Nothing to compact yet',
    description: 'The conversation is short enough to keep in full.'
  },
  {
    pattern: /Already compacted/i,
    title: 'Already compacted',
    description: 'Nothing new since the last compaction.'
  }
]

export async function compactContext(agentId: string, customInstructions?: string): Promise<void> {
  if (!requireCommand(agentId, 'compact')) return
  let cancelled = false
  // Native cancellation can rethrow a provider error; its end event carries the actual outcome.
  const unsubscribe = on('engine:event', (payload) => {
    if (
      payload.agentId === agentId &&
      payload.event.type === 'compaction_end' &&
      payload.event.reason === 'manual'
    ) {
      cancelled = payload.event.aborted
    }
  })
  const watchdog = setTimeout(() => {
    if (useAgents.getState().agents[agentId]?.compaction) return
    toast({
      level: 'warning',
      title: 'Compaction has not started',
      description: 'The Engine is still stopping the current run and compacts once it has ended.',
      duration: 7000
    })
  }, COMPACT_START_GRACE_MS)
  try {
    const result = await rpc(agentId, {
      type: 'compact',
      customInstructions: customInstructions || undefined
    })
    const after = result.estimatedTokensAfter
    toast({
      level: 'success',
      title: 'Context compacted',
      description:
        after !== undefined
          ? `${formatTokens(result.tokensBefore)} → ~${formatTokens(after)} tokens`
          : `${formatTokens(result.tokensBefore)} tokens summarized`
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const refusal = NOTHING_TO_COMPACT.find((known) => known.pattern.test(message))
    if (cancelled || /compaction cancel(?:led|ed)/i.test(message))
      toast({ level: 'info', title: 'Compaction cancelled' })
    else if (refusal)
      toast({ level: 'info', title: refusal.title, description: refusal.description })
    else fail('Could not compact the context', error)
  } finally {
    clearTimeout(watchdog)
    unsubscribe()
  }
}

export async function copyLastAssistantText(agentId: string): Promise<void> {
  if (!requireCommand(agentId, 'get_last_assistant_text')) return
  try {
    const { text } = await rpc(agentId, { type: 'get_last_assistant_text' })
    if (!text) {
      toast({
        level: 'info',
        title: 'Nothing to copy yet',
        description: 'The agent has not replied in this session.'
      })
      return
    }
    await navigator.clipboard.writeText(text)
    toast({ level: 'success', title: 'Copied the last response', duration: 2200 })
  } catch (error) {
    fail('Could not copy', error)
  }
}

export async function cycleModel(agentId: string): Promise<void> {
  if (!requireCommand(agentId, 'cycle_model')) return
  try {
    const result = await withModelChange(agentId, () => rpc(agentId, { type: 'cycle_model' }))
    if (!result) {
      toast({ level: 'info', title: 'Only one model is available', duration: 2600 })
      return
    }
    toast({
      level: 'info',
      title: result.model.name,
      description: result.isScoped
        ? 'Cycled within your scoped models'
        : `${providerLabel(result.model.provider)} · thinking ${result.thinkingLevel}`,
      duration: 2200
    })
  } catch (error) {
    fail('Could not switch model', error)
  }
}

/** The patterns the Engine scoped this agent's model cycle to: `--models` at launch, else `enabledModels`. */
function cyclePatterns(agentId: string): string[] {
  const info = useAgents.getState().agents[agentId]?.info
  const launched = info?.args.launch?.models
  if (launched && launched.length > 0) return launched
  const enabled = getEffectiveSetting('enabledModels', info?.cwd ?? null, info?.engine)
  return Array.isArray(enabled) ? enabled.filter((pattern) => typeof pattern === 'string') : []
}

/** The Engine's backward cycle (Alt+P on Windows): RPC `cycle_model` only goes forward, so pick and set the model. */
export async function cycleModelBackward(agentId: string): Promise<void> {
  if (!requireCommand(agentId, 'get_available_models') || !requireCommand(agentId, 'set_model'))
    return
  try {
    if (useAgents.getState().agents[agentId]?.info.engine === 'prime') {
      await withModelChange(agentId, () =>
        invoke('prime:command', agentId, 'cycle_model', { direction: 'backward' })
      )
      const model = useAgents.getState().agents[agentId]?.model
      if (model)
        toast({
          level: 'info',
          title: model.name,
          description: providerLabel(model.provider),
          duration: 2200
        })
      return
    }
    const previous = await withModelChange(agentId, async (assertCurrent) => {
      const { models } = await rpc(agentId, { type: 'get_available_models' })
      assertCurrent()
      const patterns = cyclePatterns(agentId)
      const selected = previousInCycle(
        useAgents.getState().agents[agentId]?.model,
        patterns,
        models
      )
      if (!selected) return null
      await rpc(agentId, {
        type: 'set_model',
        provider: selected.model.provider,
        modelId: selected.model.id
      })
      if (selected.thinkingLevel) {
        assertCurrent()
        await rpc(agentId, { type: 'set_thinking_level', level: selected.thinkingLevel })
      }
      return selected
    })
    if (!previous) {
      toast({ level: 'info', title: 'Only one model is available', duration: 2600 })
      return
    }
    const thinkingLevel = useAgents.getState().agents[agentId]?.thinkingLevel
    const description = previous.isScoped
      ? 'Cycled within your scoped models'
      : `${providerLabel(previous.model.provider)} \u00b7 thinking ${thinkingLevel}`
    toast({ level: 'info', title: previous.model.name, description, duration: 2200 })
  } catch (error) {
    fail('Could not switch model', error)
  }
}

export async function cycleThinkingLevel(agentId: string): Promise<void> {
  if (!requireCommand(agentId, 'cycle_thinking_level')) return
  try {
    const result = await withModelChange(agentId, () =>
      rpc(agentId, { type: 'cycle_thinking_level' })
    )
    if (!result) {
      toast({ level: 'info', title: 'This model has no thinking levels', duration: 2600 })
      return
    }
  } catch (error) {
    fail('Could not change the thinking level', error)
  }
}

export async function setThinkingLevel(agentId: string, level: ThinkingLevel): Promise<void> {
  if (!requireCommand(agentId, 'set_thinking_level')) return
  try {
    await useAgents.getState().setThinkingLevel(agentId, level)
  } catch (error) {
    fail('Could not change the thinking level', error)
  }
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** `provider/id:high` → spec + level. The suffix only counts when it names a thinking level (ids may contain `:`). */
export function parseModelSpec(raw: string): { spec: string; level?: ThinkingLevel } {
  const trimmed = raw.trim()
  const colon = trimmed.lastIndexOf(':')
  const suffix = colon >= 0 ? trimmed.slice(colon + 1).toLowerCase() : ''
  const level = THINKING_LEVELS.find((l) => l === suffix)
  return level ? { spec: trimmed.slice(0, colon), level } : { spec: trimmed }
}

/** Exact `provider/id`, id or name first; otherwise the best fuzzy match when it is clearly ahead. */
function resolveModel(models: Model[], spec: string): { model?: Model; candidates: number } {
  const wanted = spec.toLowerCase()
  const exact =
    models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === wanted) ??
    models.find((m) => m.id.toLowerCase() === wanted) ??
    models.find((m) => m.name.toLowerCase() === wanted)
  if (exact) return { model: exact, candidates: 1 }
  const scored = models
    .map((model) => ({
      model,
      score: Math.max(
        fuzzyMatch(`${model.provider}/${model.id}`, spec)?.score ?? -Infinity,
        fuzzyMatch(model.name, spec)?.score ?? -Infinity
      )
    }))
    .filter((s) => s.score > -Infinity)
    .sort((a, b) => b.score - a.score)
  const [best, next] = scored
  if (best && (!next || best.score - next.score >= 8))
    return { model: best.model, candidates: scored.length }
  return { candidates: scored.length }
}

/**
 * `/model <spec>[:thinking]` (cli.md --model): switch when the spec resolves to one model (exact or a clear
 * fuzzy winner), then apply the thinking suffix. Ambiguous specs open the model page filtered by the spec.
 */
export async function setModelBySpec(agentId: string, raw: string): Promise<void> {
  if (!requireCommand(agentId, 'get_available_models') || !requireCommand(agentId, 'set_model'))
    return
  const { spec, level } = parseModelSpec(raw)
  try {
    if (!spec && level) return await setThinkingLevel(agentId, level)
    const { models } = await rpc(agentId, { type: 'get_available_models' })
    const { model, candidates } = resolveModel(models, spec)
    if (!model) {
      if (candidates > 0) openPalette('models', spec)
      else
        toast({
          level: 'warning',
          title: `No model matches “${spec}”`,
          action: { label: 'Browse models', onClick: () => openPalette('models') }
        })
      return
    }
    await useAgents.getState().setModel(agentId, model.provider, model.id, level)
    const appliedLevel = useAgents.getState().agents[agentId]?.thinkingLevel
    toast({
      level: 'info',
      title: model.name,
      description: level
        ? `${providerLabel(model.provider)} · thinking ${appliedLevel}`
        : providerLabel(model.provider),
      duration: 2200
    })
  } catch (error) {
    fail('Could not switch model', error)
  }
}

/**
 * `/export <path>` (slash-commands.md) through `sessions:export`, with the engine's rules: a `.jsonl` path exports
 * the active branch as JSONL, anything else HTML; relative paths resolve against the session's folder.
 */
export async function exportSessionTo(agentId: string, outputPath: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  try {
    const result = await invoke('sessions:export', {
      sessionPath: agent.session?.sessionFile ?? agent.info.sessionFile ?? '',
      agentId,
      format: /\.jsonl$/i.test(outputPath) ? 'jsonl' : 'html',
      outputPath
    })
    if (!result) return
    const written = result.path
    toast({
      level: 'success',
      title: 'Session exported',
      description: basename(written),
      action: { label: REVEAL_LABEL, onClick: () => void invoke('sys:reveal', written) }
    })
  } catch (error) {
    fail('Could not export the session', error)
  }
}

/**
 * `/reload`: reload extensions, skills, prompts, themes and context files. In place through the bridge when it
 * is loaded (works for unsaved sessions too); otherwise restart the engine on the same session file.
 */
export async function reloadAgent(agentId: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  if (agent.phase !== 'idle')
    return void toast({
      level: 'info',
      title: 'Wait for the agent to finish before reloading',
      duration: 2600
    })
  const done = () =>
    toast({
      level: 'success',
      title: 'Reloaded',
      description: 'Extensions, skills, prompts and context files are up to date.',
      duration: 2600
    })
  try {
    if (bridge.available(agentId)) {
      await bridge.reload(agentId)
      done()
      return
    }
    // A restart resumes the session file; without one (--no-session) it would lose the conversation.
    if (!agent.session?.sessionFile)
      return void toast({
        level: 'info',
        title: 'Reload needs a saved session',
        description: 'This session is not written to disk.',
        duration: 3200
      })
    await useAgents.getState().restartAgent(agentId)
    done()
  } catch (error) {
    fail('Could not reload', error)
  }
}

/** Return queued work to the draft before aborting so the Engine cannot start a follow-up. */
export async function stopAgent(agentId: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  try {
    if (
      agent.phase !== 'running' &&
      !agent.compaction &&
      Object.values(agent.bash).some((run) => run.running)
    ) {
      if (requireCommand(agentId, 'abort_bash')) await rpc(agentId, { type: 'abort_bash' })
      return
    }
    if (!requireCommand(agentId, 'abort')) return
    // Queue events can trail their RPC replies, so ask the Engine even if no chips are visible yet.
    const restored = supportsAgentCommand(agentId, 'clear_queue') ? await drainQueue(agentId) : []
    if (restored.length > 0) {
      useDrafts.getState().patch(agentId, (draft) => ({
        text: [...restored.map((message) => message.text), draft.text]
          .filter((text) => text.trim())
          .join('\n\n'),
        images: [...restored.flatMap((message) => message.images), ...draft.images]
      }))
      focusComposer()
    }
    await useAgents.getState().abort(agentId)
  } catch (error) {
    fail('Could not stop', error)
  }
}
