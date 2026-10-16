/** The tabs of the Engine 2 session controls dialog (prime-controls.tsx), loaded when it first opens. */
import { useEffect, useState } from 'react'
import { rpc } from '../../lib/engine'
import { on } from '../../lib/ipc'
import { Badge, Button, Checkbox, Input, Select, Tabs, Textarea } from '../../ui'
import { TokenSpeedSetting } from '../composer/token-speed'
import { ListEditor, NumberField } from '../settings/controls'
import type { PrimeControlSection } from './prime-controls'
import { PrimeLimitField } from './prime-fields'
import { PrimeFactory } from './prime-factory'
import { PrimeContext, PrimeSideQuestion } from './prime-inspection'
import {
  nativeNumber,
  nativeRecord,
  nativeRows,
  nativeText,
  primeCommand,
  PrimeFeedback,
  PrimeFormField,
  usePrimeAction,
  usePrimeQuery
} from './prime-runtime'
import { PrimeSchedules } from './prime-schedules'
import { PRIME_SERVICE_TIERS } from './prime-schema'
import { PrimeSubagents } from './prime-subagents'
import { PrimeTraces } from './prime-traces'

const MAX_GOAL_LENGTH = 4000
const GOAL_OPERATIONS = new Set(['status', 'pause', 'resume', 'clear', 'stop'])

function PrimeGoal({ agentId, initialText }: { agentId: string; initialText: string }) {
  const query = usePrimeQuery(agentId, 'get_state')
  const action = usePrimeAction()
  const [objective, setObjective] = useState(initialText)
  const [budget, setBudget] = useState<number | undefined>()
  const goal = nativeRecord(nativeRecord(query.data).goal)
  const objectiveNow = nativeText(goal.objective)
  const status = nativeText(goal.status)
  const active = status === 'active'
  const paused = status === 'paused'
  const submit = async (operation?: 'pause' | 'resume' | 'clear') => {
    if (
      !operation &&
      (GOAL_OPERATIONS.has(objective.trim().toLowerCase()) || objective.trim().startsWith('--'))
    ) {
      await action.perform(() =>
        Promise.reject(
          new Error(
            'Describe the objective as a sentence. A command name cannot be used as the goal.'
          )
        )
      )
      return
    }
    const argumentsText =
      operation ?? `${budget === undefined ? '' : `--budget ${budget} `}${objective.trim()}`
    await action.perform(
      async () => {
        if (operation === 'pause') {
          await rpc(agentId, { type: 'abort' })
          await primeCommand(agentId, 'prompt_and_wait', { message: '/goal pause' })
        } else {
          await rpc(agentId, { type: 'prompt', message: `/goal ${argumentsText}` })
        }
        await query.reload()
      },
      operation === 'pause'
        ? 'Goal paused.'
        : operation
          ? 'Goal action sent.'
          : 'Goal submitted. The engine will begin working toward it.'
    )
  }

  return (
    <div className="space-y-5 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Give this session a persistent objective. Engine 2 continues until it completes the goal,
        reaches a limit, or needs your input.
      </p>
      <PrimeFeedback error={action.error ?? query.error} notice={action.notice} />
      {objectiveNow && (
        <section className="space-y-3 border-b border-hairline-soft pb-5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-fg">Current goal</h3>
            <Badge>{status || 'Pending'}</Badge>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg-2">{objectiveNow}</p>
          <p className="text-xs tabular-nums text-fg-3">
            {(nativeNumber(goal.tokensUsed) ?? 0).toLocaleString()} tokens used
            {nativeNumber(goal.tokenBudget) !== undefined &&
              ` of ${nativeNumber(goal.tokenBudget)?.toLocaleString()}`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!active}
              loading={action.pending}
              onClick={() => void submit('pause')}
            >
              Pause goal
            </Button>
            <Button
              size="sm"
              disabled={!paused}
              loading={action.pending}
              onClick={() => void submit('resume')}
            >
              Resume goal
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={action.pending}
              onClick={() => void submit('clear')}
            >
              Clear goal
            </Button>
          </div>
        </section>
      )}
      <PrimeFormField label="Objective">
        <Textarea
          aria-label="Goal objective"
          value={objective}
          maxLength={MAX_GOAL_LENGTH}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Describe the result this session should work toward…"
        />
      </PrimeFormField>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-fg-2">Token budget</h3>
          <p className="mt-1 text-xs text-fg-3">Optional. Leave blank for no explicit budget.</p>
        </div>
        <NumberField
          aria-label="Goal token budget"
          value={budget}
          min={1}
          integer
          unit="tokens"
          onCommit={setBudget}
        />
      </div>
      <Button
        variant="primary"
        disabled={!objective.trim() || active || paused}
        loading={action.pending}
        onClick={() => void submit()}
      >
        Start goal
      </Button>
      {(active || paused) && (
        <p className="text-xs text-fg-3">Clear the current goal before starting another.</p>
      )}
    </div>
  )
}

type AutonomousLimit = number | 'unlimited' | undefined

interface AutonomousLimits {
  maxContinuations: AutonomousLimit
  maxTurns: AutonomousLimit
  maxTokens: AutonomousLimit
  timeoutMs: AutonomousLimit
}

const AUTONOMOUS_FIELDS: Array<{
  key: keyof AutonomousLimits
  flag: string
  label: string
  unit?: 'ms' | 'tokens'
}> = [
  { key: 'maxContinuations', flag: 'max-continuations', label: 'Continuation limit' },
  { key: 'maxTurns', flag: 'max-turns', label: 'Turn limit' },
  { key: 'maxTokens', flag: 'max-tokens', label: 'Token limit', unit: 'tokens' },
  { key: 'timeoutMs', flag: 'timeout-ms', label: 'Time limit', unit: 'ms' }
]

// Native command arguments join adjacent quoted fragments and do not interpret backslash escapes.
function quoteNativeArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function latestCustomDetails(messages: unknown, customType: string): Record<string, unknown> {
  const latest = nativeRows(nativeRecord(messages).messages)
    .filter((message) => message.customType === customType)
    .at(-1)
  return nativeRecord(latest?.details)
}

function PrimeAutonomy({ agentId }: { agentId: string }) {
  const query = usePrimeQuery(agentId, 'get_messages')
  const stateQuery = usePrimeQuery(agentId, 'get_state')
  const action = usePrimeAction()
  const [limits, setLimits] = useState<AutonomousLimits>({
    maxContinuations: undefined,
    maxTurns: undefined,
    maxTokens: undefined,
    timeoutMs: undefined
  })
  const [gates, setGates] = useState<string[]>([])
  const [gateRetries, setGateRetries] = useState<number | undefined>()
  const [gateTimeout, setGateTimeout] = useState<number | undefined>()
  const [keepAlive, setKeepAlive] = useState<number | undefined>()
  const status = latestCustomDetails(query.data, 'autonomous_status')
  const serviceTier = nativeText(nativeRecord(stateQuery.data).serviceTier) || 'auto'
  const hasCustomLimit = Object.values(limits).some((value) => value !== undefined)
  const submit = async (enabled: boolean) => {
    const argumentsList = [enabled ? 'on' : 'off']
    if (enabled) {
      for (const field of AUTONOMOUS_FIELDS) {
        const value = limits[field.key]
        if (value !== undefined) argumentsList.push(`--${field.flag}`, String(value))
      }
      for (const command of gates) argumentsList.push('--gate', quoteNativeArgument(command))
      if (gateRetries !== undefined) argumentsList.push('--gate-retries', String(gateRetries))
      if (gateTimeout !== undefined) argumentsList.push('--gate-timeout-ms', String(gateTimeout))
      if (keepAlive !== undefined) argumentsList.push('--subagent-keep-alive-ms', String(keepAlive))
    }
    await action.perform(
      async () => {
        await rpc(agentId, { type: 'prompt', message: `/autonomous ${argumentsList.join(' ')}` })
        await query.reload()
      },
      enabled ? 'Autonomous execution requested.' : 'Autonomous execution stop requested.'
    )
  }
  return (
    <div className="space-y-5 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Allow the engine to continue after each turn, with optional limits and commands that must
        pass before completion.
      </p>
      <PrimeFeedback
        error={action.error ?? query.error ?? stateQuery.error}
        notice={action.notice}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>
            {typeof status.enabled === 'boolean'
              ? status.enabled
                ? 'Enabled'
                : 'Off'
              : 'Status not requested'}
          </Badge>
          {nativeNumber(status.turnsUsed) !== undefined && (
            <span className="text-xs tabular-nums text-fg-3">
              {nativeNumber(status.turnsUsed)} turns ·{' '}
              {nativeNumber(status.tokensUsed)?.toLocaleString() ?? 0} tokens
            </span>
          )}
        </div>
        <Button
          size="sm"
          loading={action.pending}
          onClick={() =>
            void action.perform(async () => {
              await rpc(agentId, { type: 'prompt', message: '/autonomous status' })
              await query.reload()
            })
          }
        >
          Refresh status
        </Button>
      </div>
      {nativeText(nativeRecord(status.lastGateFailure).command) && (
        <p className="text-sm text-warning">
          Gate failed: {nativeText(nativeRecord(status.lastGateFailure).command)}
        </p>
      )}
      <div className="space-y-3">
        {AUTONOMOUS_FIELDS.map((field) => (
          <div key={field.key} className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-fg-2">{field.label}</span>
            <PrimeLimitField
              label={field.label}
              value={limits[field.key]}
              special="unlimited"
              unit={field.unit}
              onChange={(value) =>
                setLimits((current) => ({
                  ...current,
                  [field.key]: value === 'off' ? undefined : value
                }))
              }
            />
          </div>
        ))}
      </div>
      {hasCustomLimit && (
        <p className="text-xs leading-relaxed text-fg-3">
          When any custom budget is set, Engine 2 treats the remaining unspecified limits as
          unlimited.
        </p>
      )}
      <PrimeFormField
        label="Completion gates"
        hint="Each command runs in the session workspace. Add commands in execution order."
      >
        <ListEditor
          value={gates}
          unique={false}
          onChange={setGates}
          placeholder="Add a check, such as npm run typecheck…"
        />
      </PrimeFormField>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-fg-2">Gate retry limit</span>
        <NumberField
          aria-label="Gate retry limit"
          value={gateRetries}
          min={1}
          integer
          onCommit={setGateRetries}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-fg-2">Gate timeout</span>
        <NumberField
          aria-label="Gate timeout"
          value={gateTimeout}
          min={1}
          integer
          unit="ms"
          onCommit={setGateTimeout}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-fg-2">Subagent keep-alive</span>
        <NumberField
          aria-label="Subagent keep-alive"
          value={keepAlive}
          min={0}
          integer
          unit="ms"
          onCommit={setKeepAlive}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={action.pending} onClick={() => void submit(true)}>
          Enable autonomous execution
        </Button>
        <Button loading={action.pending} onClick={() => void submit(false)}>
          Turn off
        </Button>
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-hairline-soft pt-5">
        <div>
          <h3 className="text-sm font-medium text-fg-2">Service tier</h3>
          <p className="mt-1 text-xs text-fg-3">Availability depends on this provider and model.</p>
        </div>
        <Select
          value={serviceTier}
          disabled={action.pending}
          options={PRIME_SERVICE_TIERS}
          onValueChange={(value) =>
            void action.perform(async () => {
              await primeCommand(agentId, 'set_service_tier', { serviceTier: value })
              await stateQuery.reload()
            }, 'Service tier updated.')
          }
        />
      </div>
    </div>
  )
}

function PrimeRefinement({ agentId, initialText }: { agentId: string; initialText: string }) {
  const [instructions, setInstructions] = useState(initialText)
  const [rollbackId, setRollbackId] = useState('')
  const [global, setGlobal] = useState(false)
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const history = usePrimeQuery(agentId, 'get_messages')
  const action = usePrimeAction()
  const outcomes = nativeRows(nativeRecord(history.data).messages)
    .filter((message) => message.customType === 'refinement_outcome')
    .map((message): Record<string, unknown> => {
      const details = nativeRecord(message.details)
      return { ...details, id: details.refinementId, appliedEdits: details.edits }
    })

  useEffect(
    () =>
      on('engine:event', ({ agentId: source, event }) => {
        if (
          source === agentId &&
          event.type === 'engine_native_event' &&
          event.name.startsWith('refinement')
        ) {
          const outcome = nativeRecord(event.data.result)
          if (outcome.id) setResult(outcome)
        }
      }),
    [agentId]
  )

  const refine = async () => {
    await action.perform(
      async () => {
        const response = nativeRecord(
          await primeCommand(agentId, 'refine', {
            instructions: instructions.trim() || undefined,
            rollbackId: rollbackId.trim() || undefined,
            global
          })
        )
        setResult(
          Object.keys(nativeRecord(response.result)).length
            ? nativeRecord(response.result)
            : response
        )
        await history.reload()
      },
      rollbackId.trim() ? 'Refinement rollback finished.' : 'Refinement finished.'
    )
  }
  const latest = result ?? outcomes.at(-1)
  const edits = nativeRows(latest?.appliedEdits)
  return (
    <div className="space-y-5 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Refine the engine’s durable instructions and memory from this session, or restore a previous
        refinement.
      </p>
      <PrimeFeedback error={action.error ?? history.error} notice={action.notice} />
      <PrimeFormField label="Refinement instructions">
        <Textarea
          aria-label="Refinement instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Optional guidance for what to learn or improve…"
        />
      </PrimeFormField>
      <label className="flex items-center gap-2 text-sm text-fg-2">
        <Checkbox checked={global} onCheckedChange={setGlobal} />
        Apply to global engine memory
      </label>
      <PrimeFormField
        label="Rollback ID"
        hint="Leave blank to create a refinement. Enter a previous refinement ID to restore it."
      >
        <Input
          aria-label="Refinement rollback ID"
          value={rollbackId}
          onChange={(event) => setRollbackId(event.target.value)}
        />
      </PrimeFormField>
      <Button variant="primary" loading={action.pending} onClick={() => void refine()}>
        {rollbackId.trim() ? 'Roll back refinement' : 'Refine now'}
      </Button>
      {latest && (
        <section className="space-y-3 border-t border-hairline-soft pt-5">
          <h3 className="text-sm font-medium text-fg">Latest refinement</h3>
          {nativeText(latest.summary) && (
            <p className="text-sm leading-relaxed text-fg-2">{nativeText(latest.summary)}</p>
          )}
          {nativeText(latest.rationale) && (
            <p className="text-sm leading-relaxed text-fg-3">{nativeText(latest.rationale)}</p>
          )}
          {nativeText(latest.id) && (
            <Button size="sm" variant="ghost" onClick={() => setRollbackId(nativeText(latest.id))}>
              Use {nativeText(latest.id)} for rollback
            </Button>
          )}
          {edits.map((edit, index) => (
            <div
              key={`${nativeText(edit.id)}:${index}`}
              className="border-t border-hairline-soft pt-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-fg-2">
                  {nativeText(edit.title) || nativeText(edit.id)}
                </span>
                <Badge>{edit.applied === true ? 'Applied' : 'Not applied'}</Badge>
              </div>
              {nativeText(edit.error) && (
                <p className="mt-1 text-sm text-danger">{nativeText(edit.error)}</p>
              )}
              {nativeText(edit.reason) && (
                <p className="mt-1 text-sm text-fg-3">{nativeText(edit.reason)}</p>
              )}
            </div>
          ))}
        </section>
      )}
      {outcomes.length > 1 && (
        <section className="space-y-2 border-t border-hairline-soft pt-5">
          <h3 className="text-sm font-medium text-fg">Earlier refinements</h3>
          {outcomes
            .slice(0, -1)
            .reverse()
            .map((outcome, index) => (
              <Button
                key={`${nativeText(outcome.id)}:${index}`}
                variant="ghost"
                className="w-full justify-start"
                onClick={() => {
                  setResult(outcome)
                  setRollbackId(nativeText(outcome.id))
                }}
              >
                {nativeText(outcome.summary) || nativeText(outcome.id) || 'Refinement outcome'}
              </Button>
            ))}
        </section>
      )}
    </div>
  )
}

interface PrimeControlTabsProps {
  agentId: string
  section: PrimeControlSection
  /** Text the dialog was opened with (a goal, refinement, trace action or side question). */
  initialText: string
  onSectionChange: (section: PrimeControlSection) => void
  onInitialTextConsumed: () => void
  onClose: () => void
}

export function PrimeControlTabs({
  agentId,
  section,
  initialText,
  onSectionChange,
  onInitialTextConsumed,
  onClose
}: PrimeControlTabsProps) {
  return (
    <Tabs
      value={section}
      onValueChange={(next) => onSectionChange(next as PrimeControlSection)}
      listClassName="overflow-x-auto overflow-y-hidden px-0"
      items={[
        {
          value: 'goal',
          label: 'Goal',
          content: <PrimeGoal agentId={agentId} initialText={initialText} />
        },
        {
          value: 'autonomy',
          label: 'Autonomy',
          content: <PrimeAutonomy agentId={agentId} />
        },
        {
          value: 'schedule',
          label: 'Schedule',
          content: <PrimeSchedules agentId={agentId} />
        },
        {
          value: 'refine',
          label: 'Refine',
          content: <PrimeRefinement agentId={agentId} initialText={initialText} />
        },
        {
          value: 'subagents',
          label: 'Subagents',
          content: <PrimeSubagents agentId={agentId} />
        },
        {
          value: 'factory',
          label: 'Factory',
          content: <PrimeFactory agentId={agentId} onOpenSettings={onClose} />
        },
        {
          value: 'context',
          label: 'Context',
          content: (
            <>
              <TokenSpeedSetting agentId={agentId} />
              <PrimeContext agentId={agentId} />
            </>
          )
        },
        {
          value: 'traces',
          label: 'Traces',
          content: (
            <PrimeTraces
              agentId={agentId}
              initialAction={initialText}
              onInitialActionConsumed={onInitialTextConsumed}
            />
          )
        },
        {
          value: 'side-question',
          label: 'Side question',
          content: <PrimeSideQuestion agentId={agentId} initialText={initialText} />
        }
      ]}
    />
  )
}
