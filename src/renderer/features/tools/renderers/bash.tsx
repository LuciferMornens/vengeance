import { Fragment } from 'react'
import { formatSubagentDuration } from '@shared/subagents'
import { useAgents } from '../../../store/agents'
import { Badge, Tooltip } from '../../../ui'
import { useSubagentRun } from '../../subagents'
import { Console } from '../Console'
import { LensMeta, LensSection } from '../LensVerdict'
import { useAgentCwd } from '../PathChip'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailNote, MonoSubject, RowDetail, ToolRow } from '../ToolRow'
import {
  baseName,
  describeSubagentPeek,
  firstLine,
  humanizeCommand,
  isActive,
  isBenignFailure,
  isRecord,
  NO_OUTPUT,
  payloadText,
  quietExitMeaning,
  reasonLine,
  resultPayload,
  shellExitCode,
  splitLensVerdict,
  splitTrailingNotes,
  str,
  stripCdPrefix,
  toolPhase
} from '../tool-utils'

/** Output lines the expanded detail keeps before "show earlier lines" (the well scrolls the rest). */
const DETAIL_TAIL_LINES = 400
const MS_PER_SECOND = 1000

/** Prompt-glyph icon for shell tools. */
export function PromptIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 4.5 6.5 8 3 11.5" />
      <path d="M8.5 11.5H13" />
    </svg>
  )
}

/** `exit N` for a failed command; success is the default and shows nothing. */
export function ExitBadge({ code }: { code: number | undefined }) {
  if (code === undefined || code === 0) return null
  return (
    <Badge tone="danger" className="font-mono font-medium">
      exit {code}
    </Badge>
  )
}

/** "in s-platform" when a command changes into another folder first; the full path is in the tooltip. */
function FolderChip({ dir }: { dir: string }) {
  return (
    <Tooltip content={dir}>
      <Badge className="font-normal">in {baseName(dir)}</Badge>
    </Tooltip>
  )
}

/** Display name of a background run (its agent), for rows that refer to it by id. */
function RunName({ agentId, runId }: { agentId: string; runId: string }) {
  const view = useSubagentRun(agentId, runId)
  return <>{view?.label ?? 'agent'}</>
}

/** The command's first line with run files named after their agent and long paths shortened. */
function CommandSubject({ agentId, command, cwd }: { agentId: string; command: string; cwd: string | undefined }) {
  const parts = humanizeCommand(firstLine(command), cwd)
  if (parts.length === 0) return <>{'\u2026'}</>
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <span key={i} className="font-sans text-fg-3">
            {'\u2039'}
            <RunName agentId={agentId} runId={part.runId} /> output{'\u203a'}
          </span>
        )
      )}
    </>
  )
}

/** "worker, reviewer" for the runs a peek reads. */
function PeekSubject({ agentId, runIds, command }: { agentId: string; runIds: string[]; command: string }) {
  return (
    <span title={command} className="min-w-0 truncate text-fg">
      {runIds.map((runId, i) => (
        <Fragment key={runId}>
          {i > 0 && ', '}
          <RunName agentId={agentId} runId={runId} />
        </Fragment>
      ))}
    </span>
  )
}

/** Shell tools: `bash`, and `powershell` (pi's built-in shell tool on Windows; same input and details). */
function ShellRow({ agentId, call, execution }: ToolRendererProps) {
  const powershell = call.name === 'powershell'
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const cwd = useAgentCwd(agentId)
  const benign = isBenignFailure(call, execution)
  const phase = benign ? 'done' : toolPhase(execution, running)
  const command = str(call.arguments.command) ?? ''
  const stripped = stripCdPrefix(command, cwd)
  const peek = describeSubagentPeek(command)
  const payload = resultPayload(execution)
  const { body: withNotes, lens } = splitLensVerdict(payloadText(payload))
  const { body: rawBody, notes } = splitTrailingNotes(withNotes)
  const body = rawBody.trim() === NO_OUTPUT ? '' : rawBody
  const exitCode = shellExitCode(payload, notes)
  const timedOut = notes.some((note) => note.startsWith('Command timed out'))
  const otherNotes = notes.filter((note) => !/^Command (exited with code|timed out|aborted)/.test(note))
  const failed = phase === 'error'
  const fullOutputPath = isRecord(payload?.details) ? str(payload.details.fullOutputPath) : undefined
  const reason = failed ? reasonLine(body) || firstLine(notes.join('\n')) : undefined
  const quietMeaning = benign ? quietExitMeaning(command, payload) : undefined
  const verb = peek ? (isActive(phase) ? 'Peeking at' : 'Peeked at') : isActive(phase) ? 'Running' : 'Ran'
  return (
    <ToolRow
      verb={verb}
      subject={
        peek ? (
          <PeekSubject agentId={agentId} runIds={peek.runIds} command={command} />
        ) : (
          <MonoSubject title={command}>
            <CommandSubject agentId={agentId} command={stripped.command} cwd={cwd} />
          </MonoSubject>
        )
      }
      meta={
        <>
          {stripped.dir && !peek && <FolderChip dir={stripped.dir} />}
          {peek?.waitedS && <span>waited {formatSubagentDuration(peek.waitedS * MS_PER_SECOND)}</span>}
          {quietMeaning && <span>{quietMeaning}</span>}
          {timedOut ? <Badge tone="danger">timed out</Badge> : <ExitBadge code={failed ? exitCode : undefined} />}
          <LensMeta lens={lens} />
        </>
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={reason || (lens?.issues ? lens.firstIssue : undefined)}
      sublineTone="danger"
      tail={phase === 'running' ? body : undefined}
      detail={
        <RowDetail copy={() => body} anchor="bottom">
          <Console
            command={command}
            output={body}
            prompt={powershell ? 'PS>' : undefined}
            live={isActive(phase)}
            bounded={false}
            tailLines={DETAIL_TAIL_LINES}
            empty={isActive(phase) ? undefined : phase === 'aborted' ? 'Stopped' : 'No output'}
          />
          {otherNotes.map((note) => (
            <DetailNote key={note}>{note}</DetailNote>
          ))}
          {fullOutputPath && <DetailNote>Output was truncated; the full output is saved in {baseName(fullOutputPath)}.</DetailNote>}
          <LensSection lens={lens} />
        </RowDetail>
      }
    />
  )
}

registerToolRenderer(['bash', 'powershell'], ShellRow)
