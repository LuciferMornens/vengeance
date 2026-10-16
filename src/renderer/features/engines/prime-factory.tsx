import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Input } from '../../ui'
import { revealSetting } from '../palette/settings-sections'
import {
  errorText,
  nativeNumber,
  nativeRecord,
  nativeRows,
  nativeText,
  primeCommand,
  PrimeFeedback,
  PrimeFormField,
  usePrimeAction
} from './prime-runtime'

const FACTORY_WATCH_TIMEOUT_MS = 10_000
const FACTORY_DISABLED_MESSAGE = 'the factory is disabled; run /factory on to enable it'

function FactorySnapshot({ snapshot }: { snapshot: Record<string, unknown> }) {
  const machine = nativeRecord(snapshot.machine)
  const states = nativeRows(machine.states)
  const nodes = nativeRows(snapshot.nodes)
  const transitions = nativeRows(machine.transitions)
  const usage = nativeRecord(snapshot.usage)
  const budget = nativeRecord(snapshot.budget)
  const rows = states.length > 0 ? states : nodes
  return (
    <div className="space-y-4">
      {Object.keys(usage).length > 0 && (
        <p className="text-xs tabular-nums text-fg-3">
          <span>{nativeNumber(usage.running) ?? 0} running · </span>
          <span>{nativeNumber(usage.settled) ?? 0} settled · </span>
          <span>{nativeNumber(usage.spawns) ?? 0} children started · </span>
          <span>{nativeNumber(usage.toolUses) ?? 0} tool uses</span>
        </p>
      )}
      {nativeNumber(budget.limitMs) !== undefined && (
        <p className="text-xs tabular-nums text-fg-3">
          {(nativeNumber(budget.consumedMs) ?? 0).toLocaleString()} of{' '}
          {nativeNumber(budget.limitMs)?.toLocaleString()} ms consumed
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-fg-3">
              <tr className="border-b border-hairline-soft">
                <th className="py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Agents</th>
                <th className="py-2 font-medium">Model</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((state) => {
                const id = nativeText(state.id)
                const node = nodes.find((item) => item.id === id) ?? state
                return (
                  <tr key={id} className="border-b border-hairline-soft align-top">
                    <td className="py-3 text-fg-2">
                      <span className="font-medium">{id}</span>
                      {state.entry === true && <span className="ml-2 text-fg-3">Entry</span>}
                      {nativeText(node.error) && (
                        <p className="mt-1 max-w-64 whitespace-pre-wrap text-danger">
                          {nativeText(node.error)}
                        </p>
                      )}
                      {nativeText(node.answerPreview) && (
                        <p className="mt-2 max-w-80 whitespace-pre-wrap leading-relaxed">
                          {nativeText(node.answerPreview)}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-fg-3">
                      {nativeText(node.status) || 'Not started'}
                      {node.needsVerify === true && <p className="mt-1">Verification required</p>}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-fg-3">
                      <span>{nativeNumber(node.running) ?? 0} running / </span>
                      <span>{nativeNumber(node.queued) ?? 0} queued</span>
                    </td>
                    <td className="py-3 text-fg-3">{nativeText(state.model) || 'Inherited'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {transitions.length > 0 && (
        <details className="text-xs text-fg-3">
          <summary className="cursor-pointer py-1">Transitions ({transitions.length})</summary>
          <ul className="mt-2 space-y-2">
            {transitions.map((transition, index) => (
              <li key={index}>
                {Array.isArray(transition.from)
                  ? transition.from.map(nativeText).join(' + ')
                  : nativeText(transition.from)}{' '}
                → {nativeText(transition.to)} · {nativeText(transition.on) || 'settled'}
              </li>
            ))}
          </ul>
        </details>
      )}
      {nativeText(snapshot.pauseReason) && (
        <p className="text-sm leading-relaxed text-fg-2">{nativeText(snapshot.pauseReason)}</p>
      )}
    </div>
  )
}

function FactoryRun({
  agentId,
  run,
  onRefresh
}: {
  agentId: string
  run: Record<string, unknown>
  onRefresh: () => Promise<void>
}) {
  const action = usePrimeAction()
  const [snapshot, setSnapshot] = useState(run)
  const [confirmStop, setConfirmStop] = useState(false)
  useEffect(() => setSnapshot(run), [run])
  const runId = nativeText(run.runId)
  const state = nativeText(snapshot.state)
  const runningChildren = nativeNumber(nativeRecord(snapshot.usage).running) ?? 0
  const live = ['running', 'paused', 'stopping'].includes(state) || runningChildren > 0
  const operate = async (operation: 'status' | 'watch' | 'stop' | 'resume') => {
    await action.perform(async () => {
      const result = nativeRecord(
        await primeCommand(agentId, 'factory_activity', {
          action: operation,
          runId,
          ...(operation === 'watch' ? { timeoutMs: FACTORY_WATCH_TIMEOUT_MS } : {})
        })
      )
      if (operation === 'status' || operation === 'watch') {
        setSnapshot((current) => ({ ...current, ...result }))
      } else {
        setConfirmStop(false)
        await onRefresh()
      }
    })
  }
  return (
    <section className="space-y-3 border-t border-hairline-soft py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-fg">
          {nativeText(run.name) || nativeText(run.specId) || runId}
        </h3>
        <Badge>{state || 'Unknown'}</Badge>
      </div>
      <p className="break-all font-mono text-xs text-fg-3">{runId}</p>
      <FactorySnapshot snapshot={snapshot} />
      <PrimeFeedback error={action.error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={action.pending} onClick={() => void operate('status')}>
          Read status
        </Button>
        <Button size="sm" loading={action.pending} onClick={() => void operate('watch')}>
          Wait for change
        </Button>
        {state === 'paused' && (
          <Button size="sm" loading={action.pending} onClick={() => void operate('resume')}>
            Resume run
          </Button>
        )}
        {live && !confirmStop && (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.pending}
            onClick={() => setConfirmStop(true)}
          >
            Stop run…
          </Button>
        )}
        {confirmStop && (
          <>
            <Button
              size="sm"
              variant="danger"
              loading={action.pending}
              onClick={() => void operate('stop')}
            >
              Stop run and children
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={action.pending}
              onClick={() => setConfirmStop(false)}
            >
              Keep running
            </Button>
          </>
        )}
      </div>
    </section>
  )
}

export function PrimeFactory({
  agentId,
  onOpenSettings
}: {
  agentId: string
  onOpenSettings: () => void
}) {
  const [runs, setRuns] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [specId, setSpecId] = useState('')
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  const generation = useRef(0)
  const action = usePrimeAction()
  const failure = action.error ?? error
  const factoryDisabled = failure?.toLowerCase().includes(FACTORY_DISABLED_MESSAGE) === true
  const reload = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = nativeRecord(
        await primeCommand(agentId, 'factory_activity', { action: 'graph' })
      )
      if (request === generation.current) setRuns(nativeRows(result.runs))
    } catch (cause) {
      if (request === generation.current) setError(errorText(cause))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [agentId])
  useEffect(() => {
    void reload()
    return () => {
      generation.current += 1
    }
  }, [reload])
  const inspectSpec = async () => {
    await action.perform(async () => {
      setPreview(
        nativeRecord(
          await primeCommand(agentId, 'factory_activity', {
            action: 'graph',
            specId: specId.trim()
          })
        )
      )
    })
  }
  const startRun = async () => {
    await action.perform(async () => {
      await primeCommand(agentId, 'factory_activity', { action: 'run', specId: specId.trim() })
      await reload()
    }, 'Factory run started.')
  }
  const openAgentSettings = () => {
    onOpenSettings()
    revealSetting('agent', 'factory.enabled', 'prime')
  }
  return (
    <div className="space-y-5 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Run a stored factory specification and inspect its stages in this session’s Python kernel.
      </p>
      {factoryDisabled && (
        <div className="space-y-3" role="status">
          <p className="text-sm leading-relaxed text-fg-2">
            Factory is off. Enable it in Engine 2’s Agent settings to coordinate saved workflows
            across subagents.
          </p>
          <Button onClick={openAgentSettings}>Open Agent settings</Button>
        </div>
      )}
      <PrimeFeedback error={factoryDisabled ? null : failure} notice={action.notice} />
      <PrimeFormField
        label="Factory specification"
        hint="Use the ID of a specification saved in the native harness."
      >
        <Input
          aria-label="Factory specification ID"
          disabled={action.pending || factoryDisabled}
          value={specId}
          onChange={(event) => {
            setSpecId(event.target.value)
            setPreview(null)
          }}
          placeholder="Specification ID"
        />
      </PrimeFormField>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={factoryDisabled || !specId.trim()}
          loading={action.pending}
          onClick={() => void inspectSpec()}
        >
          Preview specification
        </Button>
        <Button
          variant="primary"
          disabled={factoryDisabled || !specId.trim() || preview === null}
          loading={action.pending}
          onClick={() => void startRun()}
        >
          Start factory run
        </Button>
        <Button
          variant="ghost"
          loading={loading || action.pending}
          onClick={() => void action.perform(reload)}
        >
          Refresh runs
        </Button>
      </div>
      {preview && <FactorySnapshot snapshot={preview} />}
      {loading && runs.length === 0 && (
        <p className="text-sm text-fg-3" role="status">
          Loading factory runs…
        </p>
      )}
      {!loading && !error && runs.length === 0 && (
        <p className="text-sm text-fg-3">No factory runs in this session.</p>
      )}
      {runs.map((run) => (
        <FactoryRun key={nativeText(run.runId)} agentId={agentId} run={run} onRefresh={reload} />
      ))}
    </div>
  )
}
