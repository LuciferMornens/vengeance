import { useState } from 'react'
import { Pause, Play, RefreshCw, Square, Trash2 } from 'lucide-react'
import { Badge, Button, IconButton, Input, Select, Skeleton, Textarea } from '../../ui'
import { NumberField } from '../settings/controls'
import {
  nativeRecord,
  nativeRows,
  nativeText,
  primeCommand,
  PrimeFeedback,
  PrimeFormField,
  usePrimeAction,
  usePrimeQuery
} from './prime-runtime'

type ScheduleKind = 'heartbeat' | 'once' | 'recurring' | 'cron'
type ScheduleUnit = 's' | 'm' | 'h' | 'd'

interface NativeScheduledJob {
  id: string
  activeSessionId: string
  prompt: string
  status: string
  schedule: string
  nextRunAt: string
  lastError: string
  sessionName: string
  source: string
}

function scheduledJob(value: unknown, sessionName = ''): NativeScheduledJob | null {
  const record = nativeRecord(value)
  const jobId = nativeText(record.id)
  if (!jobId) return null
  return {
    id: jobId,
    activeSessionId: nativeText(record.activeSessionId),
    prompt: nativeText(record.prompt),
    status: nativeText(record.status),
    schedule: nativeText(nativeRecord(record.schedule).expression),
    nextRunAt: nativeText(record.nextRunAt),
    lastError: nativeText(record.lastError),
    sessionName,
    source: nativeText(record.source)
  }
}

function scheduleTime(value: string): string {
  if (!value) return ''
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString()
}

function ScheduleJobRow({
  job,
  heartbeat,
  canClear = false,
  busy,
  onAction
}: {
  job: NativeScheduledJob
  heartbeat: boolean
  canClear?: boolean
  busy: boolean
  onAction: (action: 'pause' | 'resume' | 'stop' | 'clear') => void
}) {
  return (
    <div className="border-b border-hairline-soft py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
            {job.prompt}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-3">
            <Badge>{job.status || 'Scheduled'}</Badge>
            <span>{job.schedule}</span>
            {job.sessionName && <span>{job.sessionName}</span>}
          </div>
          {job.nextRunAt && (
            <p className="mt-1 text-xs text-fg-3">Next run: {scheduleTime(job.nextRunAt)}</p>
          )}
          {job.lastError && <p className="mt-2 text-xs text-danger">{job.lastError}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {heartbeat && job.status === 'active' && (
            <IconButton label="Pause heartbeat" disabled={busy} onClick={() => onAction('pause')}>
              <Pause />
            </IconButton>
          )}
          {heartbeat && job.status === 'paused' && (
            <IconButton label="Resume heartbeat" disabled={busy} onClick={() => onAction('resume')}>
              <Play />
            </IconButton>
          )}
          {(job.status === 'active' || job.status === 'paused') && (
            <IconButton
              label={heartbeat ? 'Stop heartbeat' : 'Cancel scheduled prompt'}
              disabled={busy}
              onClick={() => onAction('stop')}
            >
              <Square />
            </IconButton>
          )}
          {canClear && (
            <IconButton label="Clear heartbeat" disabled={busy} onClick={() => onAction('clear')}>
              <Trash2 />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  )
}

const DEFAULT_SCHEDULE_INTERVAL = 5
const MIN_RECURRING_INTERVAL_SECONDS = 10
const MILLISECONDS_PER_SECOND = 1_000

export function PrimeSchedules({ agentId }: { agentId: string }) {
  const currentQuery = usePrimeQuery(agentId, 'heartbeat_get')
  const heartbeatsQuery = usePrimeQuery(agentId, 'heartbeats_list')
  const schedulesQuery = usePrimeQuery(agentId, 'cron_list')
  const action = usePrimeAction()
  const [kind, setKind] = useState<ScheduleKind>('heartbeat')
  const [amount, setAmount] = useState<number | undefined>(DEFAULT_SCHEDULE_INTERVAL)
  const [unit, setUnit] = useState<ScheduleUnit>('m')
  const [expression, setExpression] = useState('')
  const [prompt, setPrompt] = useState('')
  const [delivery, setDelivery] = useState<'steer' | 'follow_up'>('follow_up')
  const current = scheduledJob(nativeRecord(currentQuery.data).heartbeat)
  const heartbeats = nativeRows(nativeRecord(heartbeatsQuery.data).heartbeats)
    .map((row) => scheduledJob(row.job, nativeText(row.sessionName)))
    .filter((job): job is NativeScheduledJob => !!job && job.id !== current?.id)
  const schedules = nativeRows(nativeRecord(schedulesQuery.data).jobs)
    .map((row) => scheduledJob(row))
    .filter((job): job is NativeScheduledJob => !!job && job.source === 'cron')
  const reload = async () => {
    await Promise.all([currentQuery.reload(), heartbeatsQuery.reload(), schedulesQuery.reload()])
  }
  const intervalValid =
    amount !== undefined &&
    amount > 0 &&
    (kind === 'once' || unit !== 's' || amount >= MIN_RECURRING_INTERVAL_SECONDS)
  const canSave =
    prompt.trim().length > 0 && (kind === 'cron' ? !!expression.trim() : intervalValid)
  const save = async () => {
    const saved = await action.perform(
      async () => {
        const schedule =
          kind === 'cron'
            ? expression.trim()
            : kind === 'once' && unit === 's'
              ? `at ${new Date(Date.now() + (amount ?? 0) * MILLISECONDS_PER_SECOND).toISOString()}`
              : `${kind === 'once' ? 'in' : 'every'} ${amount ?? ''}${unit}`
        if (kind === 'heartbeat') {
          await primeCommand(agentId, 'heartbeat_set', {
            schedule,
            prompt: prompt.trim(),
            deliveryMode: delivery
          })
        } else {
          await primeCommand(agentId, 'cron_add', { schedule, prompt: prompt.trim() })
        }
        await reload()
      },
      kind === 'heartbeat' ? 'Heartbeat saved.' : 'Scheduled prompt added.'
    )
    if (saved) setPrompt('')
  }
  const manage = async (
    job: NativeScheduledJob,
    operation: 'pause' | 'resume' | 'stop' | 'clear',
    heartbeat: boolean
  ) => {
    await action.perform(
      async () => {
        if (!heartbeat) await primeCommand(agentId, 'cron_cancel', { jobId: job.id })
        else if (current?.id === job.id)
          await primeCommand(agentId, 'heartbeat_update', { action: operation })
        else {
          if (operation === 'clear')
            throw new Error('Only this session’s heartbeat can be cleared.')
          if (!job.activeSessionId)
            throw new Error('The heartbeat owner is unavailable. Refresh schedules.')
          await primeCommand(agentId, 'heartbeat_manage', {
            jobId: job.id,
            activeSessionId: job.activeSessionId,
            action: operation
          })
        }
        await reload()
      },
      operation === 'pause'
        ? 'Heartbeat paused.'
        : operation === 'resume'
          ? 'Heartbeat resumed.'
          : 'Schedule stopped.'
    )
  }

  return (
    <div className="space-y-6 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Heartbeats revisit this session. Scheduled prompts run once or repeat at a chosen interval.
        They keep running when you close the session view.
      </p>
      <PrimeFeedback
        error={action.error ?? currentQuery.error ?? heartbeatsQuery.error ?? schedulesQuery.error}
        notice={action.notice}
      />
      <div className="space-y-4">
        <PrimeFormField label="Schedule type">
          <Select<ScheduleKind>
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'heartbeat', label: 'Session heartbeat' },
              { value: 'once', label: 'Run once after a delay' },
              { value: 'recurring', label: 'Recurring prompt' },
              { value: 'cron', label: 'Calendar or cron expression' }
            ]}
          />
        </PrimeFormField>
        <PrimeFormField
          label={kind === 'once' ? 'Delay' : 'Schedule'}
          hint={
            kind === 'cron'
              ? 'Use “at” with an ISO date, @hourly, or a five-field cron expression.'
              : 'Recurring schedules have a minimum interval of 10 seconds.'
          }
        >
          {kind === 'cron' ? (
            <Input
              aria-label="Schedule expression"
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              placeholder="0 9 * * 1-5"
            />
          ) : (
            <div className="flex items-center gap-2">
              <NumberField
                aria-label="Schedule interval"
                value={amount}
                min={1}
                integer
                onCommit={setAmount}
              />
              <Select<ScheduleUnit>
                value={unit}
                onValueChange={setUnit}
                options={[
                  { value: 's', label: 'Seconds' },
                  { value: 'm', label: 'Minutes' },
                  { value: 'h', label: 'Hours' },
                  { value: 'd', label: 'Days' }
                ]}
              />
            </div>
          )}
        </PrimeFormField>
        {kind === 'heartbeat' && (
          <PrimeFormField label="When the session is busy">
            <Select<'steer' | 'follow_up'>
              value={delivery}
              onValueChange={setDelivery}
              options={[
                { value: 'follow_up', label: 'Queue a follow-up' },
                { value: 'steer', label: 'Steer the current turn' }
              ]}
            />
          </PrimeFormField>
        )}
        <PrimeFormField label="Instructions">
          <Textarea
            aria-label="Scheduled instructions"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe what the engine should check or work on…"
          />
        </PrimeFormField>
        <Button
          variant="primary"
          disabled={!canSave}
          loading={action.pending}
          onClick={() => void save()}
        >
          {kind === 'heartbeat'
            ? current
              ? 'Replace heartbeat'
              : 'Create heartbeat'
            : 'Add scheduled prompt'}
        </Button>
      </div>
      <section className="border-t border-hairline-soft pt-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-fg">This session</h3>
          <IconButton
            label="Refresh schedules"
            onClick={() => void reload()}
            disabled={action.pending}
          >
            <RefreshCw />
          </IconButton>
        </div>
        {currentQuery.loading && !current && <Skeleton className="h-16 w-full" />}
        {current && (
          <ScheduleJobRow
            job={current}
            heartbeat
            canClear
            busy={action.pending}
            onAction={(operation) => void manage(current, operation, true)}
          />
        )}
        {schedules.map((job) => (
          <ScheduleJobRow
            key={job.id}
            job={job}
            heartbeat={false}
            busy={action.pending}
            onAction={(operation) => void manage(job, operation, false)}
          />
        ))}
        {!currentQuery.loading && !schedulesQuery.loading && !current && schedules.length === 0 && (
          <p className="py-3 text-sm text-fg-3">This session has no active schedules.</p>
        )}
      </section>
      {heartbeats.length > 0 && (
        <section className="border-t border-hairline-soft pt-5">
          <h3 className="mb-2 text-sm font-medium text-fg">Other heartbeats</h3>
          {heartbeats.map((job) => (
            <ScheduleJobRow
              key={job.id}
              job={job}
              heartbeat
              busy={action.pending}
              onAction={(operation) => void manage(job, operation, true)}
            />
          ))}
        </section>
      )}
    </div>
  )
}
