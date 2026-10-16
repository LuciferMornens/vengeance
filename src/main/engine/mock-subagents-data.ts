/**
 * Fixtures for the mock `subagents` script, copied from real pi-subagents 0.77 sessions (paths rewritten to
 * C:\Users\dev\…, run ids kept). Model-facing text is reproduced verbatim on purpose: the UI must never show it.
 */
import type { SubagentInspectMessage } from '@shared/subagents'

export const WORKSPACE = 'C:\\Users\\dev\\projects\\aurora'
const TEMP_RUNS = 'C:\\Users\\dev\\AppData\\Local\\Temp\\pi-subagents-user-dev\\async-subagent-runs'
const SESSIONS = 'C:\\Users\\dev\\.pi\\agent\\sessions\\--C--Users--dev--projects--aurora--'

export const RUN_IDS = {
  worker: '967ce01c-715d-4775-925f-e95093f91615',
  reviewer: 'ef5b44ac-ac60-456b-89c3-2be8d7115cb8',
  workflow: '2751deb6-90f7-4eb3-8e2c-b38b23a0cdcd',
  resumed: '7c6d092b-7d8b-4f96-9d83-79985ca07929'
} as const

export const REQUEST_ID = '960e9633-57dd-41ca-aad9-562218772a17'
const MISSION_ID = '2c710203-37c0-4b36-b217-bad1dfb2499b'

export const WORKER_TASK = `Fix the session-tree jump on fork. When the user forks from a message in the Branches tab, the tree scrolls to the top and the selected node loses focus; the inspector should keep the forked node in view and selected.

You are LANE S-SESSIONS (sessions + tree + inspector) of Wave 2 for "Aurora". Your cwd is a dedicated git worktree. Own only src/renderer/features/sessions/** and src/renderer/features/inspector/**. Reproduce with the mock engine (VENGEANCE_MOCK=1, the "parity" script), fix the scroll anchoring in SessionTree.tsx, keep the virtualized list stable while new entries stream in, then run npm run typecheck, npm run build and npm run shots and read every inspector PNG. Commit in small steps and report the commits, the files and anything you could not verify.`

export const REVIEWER_TASK = `Review the tool rows redesign for regressions. Read the diff of lane/t-tools against main, run the chat shots, and list every place where a finished tool call still takes more than one row, where model-facing text leaks into the transcript, or where keyboard focus is lost. Write the findings to reports/r1-code.md, most severe first.`

export const STEER_MESSAGE =
  'FYI from supervisor: Electron 44 removed File.path. If you need dropped-file paths (drag-drop files → @-references), add EXACTLY this additive bridge method (Lane D is adding the identical one, so the merge stays clean): preload src/preload/index.ts `pathForFile: (file: File): string => webUtils.getPathForFile(file)` on window.vengeance, plus `pathForFile(file: File): string` in the VengeanceBridge type in src/shared/ipc.ts. Report it as an edit outside your paths.'

export const RESUME_MESSAGE =
  'You hit the 30-min timeout. I committed your progress as a checkpoint on main ("wip(sessions)…"); main-process typecheck passes. Continue the tree fix from where you stopped: keep the forked node selected, then run all validation gates (typecheck, build, shots — READ the PNGs). Commit in logical chunks as you go so progress is never lost.'

export const SUPERVISOR_REPLY =
  'Option A approved. Add `pathForFile(file: File): string` to the bridge and the type in src/shared/ipc.ts, and list both as edits outside your owned paths. I will resolve any one-line merge conflicts with the other lanes.'

export const SUPERVISOR_QUESTION =
  "Lane D onboarding step 3 needs a folder drop zone. Electron 44 removed File.path, so the renderer can only get a dropped folder's path via `webUtils.getPathForFile(file)` exposed from the preload. src/preload/index.ts + the VengeanceBridge type in src/shared/ipc.ts are foundation files outside my allowed paths. Options: (A) I make a tiny additive change: add `pathForFile(file: File): string` to the bridge (preload: `pathForFile: (f) => webUtils.getPathForFile(f)`, plus the type in shared/ipc.ts) and report it — composer lane will probably want the same. (B) No preload change: the drop zone accepts the drop only as a visual cue and then opens the folder picker (weak). Recommend A. Which?"

export const PARENT_WAKE_TEXT =
  'Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.'

const PARENT_ACTION =
  'Parent action: Read the saved results above and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.'

export const REVIEWER_SUMMARY = `The tool rows hold up: every settled group folds to one line and no model-facing text reached the transcript in the chat shots. Three findings, most severe first.

1. **Focus is lost after Ctrl+O.** Expanding every group moves focus to the transcript root, so keyboard users lose their place.
2. **Lens footers stay in edit output.** \`splitLensVerdict\` misses the \`Post-apply analysis:\` header when it is the only footer.
3. **\`in <dir>\` chip shows for the session cwd** when the path uses forward slashes.`

export const REVIEWER_OUTPUT_PATH = `${SESSIONS}\\subagent-artifacts\\${RUN_IDS.reviewer}_reviewer_output.md`

export function asyncDir(runId: string): string {
  return `${TEMP_RUNS}\\${runId}`
}

/** The parent peeking at children's live output logs with bash, as models write it (forward slashes, quoted). */
export function peekCommand(waitSeconds: number, peeks: Array<{ runId: string; bytes: number }>): string {
  const tails = peeks.map(({ runId, bytes }) => `tail -c ${bytes} "${asyncDir(runId).replace(/\\/g, '/')}/output-0.log"`)
  return `sleep ${waitSeconds}; ${tails.join('; echo; ')}`
}

/** What those tails print: the end of each child's output log (tool lines and assistant text). */
export const PEEK_OUTPUT = `read: src/renderer/features/inspector/SessionTree.tsx
edit: src/renderer/features/inspector/SessionTree.tsx
bash: npm run typecheck
Typecheck passes. Moving on to the shots to check the forked node stays selected.

read: src/renderer/features/chat/ActivityGroup.tsx
bash: npm run shots -- chat
Three findings so far; writing them to reports/r1-code.md.`

/** A clean typecheck counted with grep: zero matches, so grep exits 1 (a success, not a failure). */
export const GREP_COUNT_COMMAND = 'npm run typecheck 2>&1 | grep -c error'
export const GREP_COUNT_OUTPUT = '0\n\nCommand exited with code 1'

export function launchText(agent: string, runId: string): string {
  return `Run fan-out: 1/64 used, 63 remaining
Async: ${agent} [${runId}]

Detached. Return control now: native completion wakes you, so do not sleep, poll, or call bg_wait for it.
One-shot check: subagent({ action: "status", id: "..." }).
Mission: ${MISSION_ID} (active)`
}

export function launchDetails(runId: string, toolCallId: string, timeoutMs: number, deadlineAt: number): Record<string, unknown> {
  return {
    mode: 'single',
    runId,
    toolCallId,
    results: [],
    asyncId: runId,
    asyncDir: asyncDir(runId),
    launchContractDigest: 'c0b6650d1df3cea2ffdf2ff86beda5b4338435595f0dec4dbcf84ccb6db641c0',
    context: 'fresh',
    timeoutMs,
    deadlineAt,
    runFanoutBudget: { used: 1, limit: 64, remaining: 63 },
    missionId: MISSION_ID,
    missionPath: `C:\\Users\\dev\\.pi\\agent\\missions\\projects\\77784cf595e2fe2c\\${MISSION_ID}.json`
  }
}

export function steerText(runId: string, requestId: string, message: string): string {
  return `Steering queued for async run ${runId} (request ${requestId}).\n\nMessage sent:\n\`\`\`text\n${message.slice(0, 160)}...\n\`\`\``
}

export function statusText(runId: string): string {
  return `Status target: run ${runId}
Spawn budget: unlimited
Active async capacity: 0/unlimited used
Run: ${runId}
State: running
Process terminal: pending
Activity: active now
Mode: single
Run fan-out: 1/64 used, 63 remaining
Progress: step 1/1
Dir: ${asyncDir(runId)}
Output: ${asyncDir(runId)}\\output-0.log
Step 1: worker: Fix the session-tree jump on fork. When the user forks from... running (anthropic/claude-opus-5-5 · thinking high), active now
  Intercom target: subagent-worker-${runId}-1 (if registered)
  Steer: subagent({ action: "steer", id: "${runId}", message: "...", options: { index: 0 } })
Events: ${asyncDir(runId)}\\events.jsonl`
}

export function resumeText(source: string, runId: string): string {
  return `Revived async subagent from ${source}.
Revived run: ${runId}
Agent: worker
Session: ${SESSIONS}\\f39cacf6-d26f-4845-833e-3d425c194616\\run-0\\session.jsonl
Async dir: ${asyncDir(runId)}
Intercom target: subagent-worker-${runId}-1 (if registered)
Status if needed: subagent({ action: "status", id: "${runId}" })

Detached. Return control now: native completion wakes you, so do not sleep, poll, or call bg_wait for it.
One-shot check: subagent({ action: "status", id: "..." }).`
}

export function supervisorRequestContent(runId: string): string {
  return `Subagent needs a supervisor decision.
Run: ${runId}
Agent: worker
Child index: 0

${SUPERVISOR_QUESTION}

Reply with: subagent_supervisor({ action: "reply", replyTo: "${REQUEST_ID}", message: "..." })

Live guidance: subagent({ action: "steer", id: "${runId}", message: "...", options: { index: 0 } }) (Reply to the pending request first.)`
}

export function supervisorRequestDetails(runId: string): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    requestId: REQUEST_ID,
    reason: 'need_decision',
    expectsReply: true,
    runId,
    agent: 'worker',
    childIndex: 0,
    childTarget: `subagent-worker-${runId}-1`,
    requestBody: SUPERVISOR_QUESTION,
    replyHint: `subagent_supervisor({ action: "reply", replyTo: "${REQUEST_ID}", message: "..." })`
  }
}

export function controlNotice(runId: string, at: number): { content: string; details: Record<string, unknown> } {
  const content = `Subagent needs attention: worker
Run: ${runId} step 1
Signal: worker has had tool 'bash' open for 240s
Facts: 165 turns | 96695 tokens | 192 tools | tool bash 240s | path &1
Hint: Inspect the running command and recent output before nudging. A queued steer does not cancel an in-flight bash call. A dev server or watch command may intentionally never return. Elapsed time alone does not prove the command is stuck.
Command: subagent({"action":"command.status","id":"${runId}","options":{"index":0,"toolCallId":"toolu_01PSxPxUh8mApBtBvCyXfdaa"}})
Status: subagent({ action: "status", id: "${runId}" })`
  return {
    content,
    details: {
      event: {
        type: 'needs_attention',
        from: 'active_long_running',
        to: 'needs_attention',
        ts: at,
        runId,
        agent: 'worker',
        index: 0,
        message: "worker has had tool 'bash' open for 240s",
        reason: 'tool_open_threshold',
        turns: 165,
        tokens: 96_695,
        toolCount: 192,
        currentTool: 'bash',
        toolCallId: 'toolu_01PSxPxUh8mApBtBvCyXfdaa',
        currentToolDurationMs: 240_999,
        currentPath: '&1',
        taskPreview: '[prompt redacted]'
      },
      source: 'async',
      asyncDir: asyncDir(runId),
      childIntercomTarget: `subagent-worker-${runId}-1`,
      noticeText: content
    }
  }
}

export function notifyCompleted(agent: string, runId: string, summary: string, outputPath: string): string {
  return `Background task completed: **${agent}**

${agent}:
${summary}
…
Full output: ${outputPath} (4.0 KB, 55 lines). Read it if needed.

Retention-managed async directory: ${asyncDir(runId)}

Session file: ${SESSIONS}\\f39cacf6-d26f-4845-833e-3d425c194616\\run-0\\session.jsonl

${PARENT_ACTION}`
}

export function notifyFailed(agent: string, runId: string, timeoutMs: number): string {
  return `Background task failed: **${agent}**

Subagent timed out after ${timeoutMs}ms.

Retention-managed async directory: ${asyncDir(runId)}

Session file: ${SESSIONS}\\f39cacf6-d26f-4845-833e-3d425c194616\\run-0\\session.jsonl

${PARENT_ACTION}`
}

export function notifyDetails(agent: string, runId: string, status: 'completed' | 'failed', durationMs: number): Record<string, unknown> {
  return {
    runs: [{ agent, status, asyncDir: asyncDir(runId), durationMs, runId, sessionLabel: 'Session file', sessionValue: `${SESSIONS}\\run-0\\session.jsonl` }]
  }
}

/**
 * A child's latest transcript parts, as `/subagents-inspect-rpc` returns them (pi-subagents `sessionMessageParts`):
 * tool calls carry only `[tool: <name>]` (pi stores arguments as `arguments`, which the reader does not pick up), and
 * tool results arrive as `toolResult`-role text.
 */
export function inspectMessages(label: string): SubagentInspectMessage[] {
  const isReviewer = label === 'reviewer'
  const file = isReviewer ? 'src/renderer/features/chat/ActivityGroup.tsx' : 'src/renderer/features/inspector/SessionTree.tsx'
  const tool = (name: string): SubagentInspectMessage => ({ role: 'assistant', kind: 'toolCall', name, text: `[tool: ${name}]` })
  const result = (text: string): SubagentInspectMessage => ({ role: 'toolResult', kind: 'text', text })
  return [
    { role: 'assistant', kind: 'text', text: isReviewer ? 'Reading the tool rows diff first, then the chat shots.' : 'Reproducing the jump with the parity script before touching the tree.' },
    tool('read'),
    result(`import { memo, useEffect, useMemo, useRef } from 'react'\nimport { useVirtualizer } from '@tanstack/react-virtual'`),
    tool('grep'),
    result(`${file}:212:    list.scrollToIndex(index, { align: 'start' })\n${file}:240:  useEffect(() => list.scrollToIndex(0), [entries])`),
    tool('edit'),
    result(`Successfully replaced 2 block(s) in ${file}.`),
    tool('bash'),
    result("SessionTree.tsx(212,9): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'."),
    tool('edit'),
    result(`Successfully replaced 1 block(s) in ${file}.`),
    { role: 'assistant', kind: 'text', text: 'Typecheck passes. **Moving on to the shots** to check the forked node stays selected.' },
    tool('bash')
  ]
}

export function costData(runs: Array<{ agent: string; runId: string; input: number; output: number; cost: number; turns: number }>): Record<string, unknown> {
  const usage = (run: { input: number; output: number; cost: number; turns: number }) => ({ input: run.input, output: run.output, cacheRead: run.input * 4, cacheWrite: 0, cost: run.cost, turns: run.turns })
  return {
    version: 1,
    parent: { input: 41_200, output: 3_900, cacheRead: 160_000, cacheWrite: 0, cost: 0.62, turns: 6 },
    children: runs.map((run, i) => ({ label: `Child ${i + 1} (${run.agent})`, runId: run.runId, usage: usage(run) })),
    unresolvedAsyncChildren: 0
  }
}
