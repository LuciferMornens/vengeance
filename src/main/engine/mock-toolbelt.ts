import type { AgentMessage } from '@shared/engine-types'
import { supervisorReplyPrompt } from '@shared/subagents'
import { call, displayDiff, ScriptBuilder, text, type MockStep, type ScriptContext } from './mock-builder'
import { forwardSlashes, mockVolumePath } from './mock-paths'
import {
  asyncDir,
  controlNotice,
  launchDetails,
  launchText,
  notifyCompleted,
  notifyDetails,
  notifyFailed,
  PARENT_WAKE_TEXT,
  REQUEST_ID,
  RESUME_MESSAGE,
  resumeText,
  REVIEWER_OUTPUT_PATH,
  REVIEWER_SUMMARY,
  REVIEWER_TASK,
  RUN_IDS,
  STEER_MESSAGE,
  statusText,
  steerText,
  SUPERVISOR_REPLY,
  supervisorRequestContent,
  supervisorRequestDetails,
  WORKER_TASK,
  WORKSPACE
} from './mock-subagents-data'

/**
 * The `toolbelt` script: every tool row shape, with real pi / pi-lens / pi-web-access result shapes.
 * Run 1 (pause labels `bash-live`, then `delegation` once it has settled): shell calls (lens footer, a live
 * tail, exit 1, aborted), reads (text and image), an edit with a lens STOP verdict, a write, search, every
 * lens tool, web, todo, history and a hidden plumbing call.
 * Runs 2–4 (`delegation` onwards; `needs-decision` pauses with the supervisor request open): subagent launches (async and foreground), steer, status, management, the
 * child-has-no-command check, shell peeks at the runs' output logs, a `grep -c` that exits 1 with no match, the
 * supervisor request, attention and completion notices, the wake prompt, a user reply prompt, resume and
 * bg_wait, all with the fixtures of the `subagents` script. No live snapshot is sent: rows here show the
 * no-snapshot fallback.
 */

const LENS_CLEAN = '\u2713 JavaScript/TypeScript clean \u00b7 3682ms'
const LENS_STOP = `\u{1F534} STOP \u2014 3 issue(s) must be fixed:
  L49: 'cn' is declared but its value is never read.
      \u2192 import { cn } from '../../lib/cn'
  L112: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
      \u2192 const label = node.label
  L140: Not all code paths return a value.
      \u2192 function anchorFor(node: TreeNode) {`
const LANE = forwardSlashes(mockVolumePath('coding', 'vengeance-lanes', 's-platform'))

const TYPECHECK_OUT = `> vengeance@0.1.0 typecheck
> tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit
`

const SHOTS_LINES = [
  '[shots] chat-tools-settled \u2713 1440\u00d7900',
  '[shots] chat-tools-error-pinned \u2713 1440\u00d7900',
  '[shots] chat-tools-cancelled \u2713 1440\u00d7900',
  '[shots] chat-tools-row-expanded \u2713 1440\u00d7900',
  '[shots] chat-tools-edit-lens \u2713 1440\u00d7900',
  '[shots] chat-tools-lens-rows \u2713 1440\u00d7900',
  '[shots] chat-tools-web-rows \u2713 1440\u00d7900',
  '[shots] chat-subagent-rows \u2713 1440\u00d7900'
]

const TEST_OUT = `> vengeance@0.1.0 test
> vitest run

 \u2713 src/shared/subagents.test.ts (14 tests) 18ms
 \u2713 src/renderer/features/tools/tool-utils.test.ts (22 tests) 9ms
 \u276F src/renderer/features/chat/transcript-items.test.ts (9 tests | 1 failed) 31ms
   \u00d7 folds the wake prompt into the notices before it
     \u2192 expected 3 items, received 4

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 44 passed (45)

Command exited with code 1`

const DEV_OUT = `> vengeance@0.1.0 dev
> electron-vite dev

vite v6.3.5 building SSR bundle for development...
\u2713 41 modules transformed.
dev server running for the electron renderer process at:
  \u279C  Local:   http://localhost:5173/

Command aborted`

const TREE_OLD = `export function SessionTree({ nodes, selectedId }: SessionTreeProps) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [nodes])
  return <TreeList ref={listRef} nodes={nodes} selectedId={selectedId} />
}`

const TREE_NEW = `export function SessionTree({ nodes, selectedId }: SessionTreeProps) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = listRef.current?.querySelector(\`[data-node-id="\${selectedId}"]\`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [nodes, selectedId])
  return <TreeList ref={listRef} nodes={nodes} selectedId={selectedId} />
}`

const NOTES_MD = `# Tree anchoring

The tree keeps the selected node in view after a fork. New entries append below without moving it.
`

const SEARCH_ANSWER = `Electron 32 removed \`File.path\`. Use \`webUtils.getPathForFile(file)\` from the preload and expose it over the context bridge.

Sources: [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes), [webUtils](https://www.electronjs.org/docs/latest/api/web-utils), [Drag and drop files](https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop)`

const FETCH_URLS = [
  'https://www.electronjs.org/docs/latest/api/web-utils',
  'https://www.electronjs.org/docs/latest/breaking-changes',
  'https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop',
  'https://github.com/electron/electron/issues/42123',
  'https://github.com/electron/electron/pull/42234',
  'https://stackoverflow.com/questions/78421937',
  'https://developer.mozilla.org/en-US/docs/Web/API/File',
  'https://web.dev/articles/read-files'
]

/** A 2-colour SVG "screenshot" as a read image block. */
function screenshot(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#121216"/><rect width="84" height="200" fill="#18181d"/><rect x="12" y="16" width="56" height="8" rx="4" fill="#ff6a3d"/><rect x="100" y="18" width="160" height="12" rx="4" fill="#ffffff" opacity="0.3"/><rect x="100" y="48" width="196" height="9" rx="4.5" fill="#ffffff" opacity="0.16"/><rect x="100" y="70" width="150" height="9" rx="4.5" fill="#ffffff" opacity="0.16"/></svg>`
  return Buffer.from(svg).toString('base64')
}

function customMessage(b: ScriptBuilder, customType: string, content: string, details: Record<string, unknown>, at: number): void {
  const message: AgentMessage = { role: 'custom', customType, content, display: true, details, timestamp: at }
  b.emit({ type: 'message_start', message })
  b.emit({ type: 'message_end', message }, 16)
  b.produced.push(message)
}

function settle(b: ScriptBuilder): void {
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.emit({ type: 'agent_settled', aborted: false }, 20)
}

/** Every tool row shape (bash live/settled/failed/stopped, reads, edits with lens verdicts, search, lens, web, todo, subagents). */
export function toolbelt(ctx: ScriptContext): MockStep[] {
  const b = new ScriptBuilder(ctx)
  b.emit({ type: 'agent_start' })
  toolsRun(b, ctx)
  settle(b)
  b.label('delegation')
  delegation(b, ctx)
  return b.steps
}

function toolsRun(b: ScriptBuilder, ctx: ScriptContext): void {
  b.turn(() => {
    b.user(ctx.prompt)
    const typecheck = call('bash', { command: `cd "${LANE}" && npm run typecheck`, timeout: 300 })
    const shots = call('bash', { command: 'npm run shots -- chat', timeout: 600 })
    const test = call('bash', { command: 'npm test', timeout: 600 })
    const readFile = call('read', { path: 'src/renderer/features/inspector/SessionTree.tsx', offset: 1, limit: 120 })
    const readImage = call('read', { path: '.shots/inspector-branches.png' })
    const message = b.assistant([{ text: 'Checking the build, the running shots and the tests first.' }, { tool: typecheck }, { tool: shots }, { tool: test }, { tool: readFile }, { tool: readImage }])
    const results = [
      b.tool(typecheck, text(`${TYPECHECK_OUT}\n${LENS_CLEAN}`), { durationMs: 3_420, updates: [text(TYPECHECK_OUT)] }),
      b.tool(shots, text(SHOTS_LINES.join('\n')), {
        durationMs: 2_400,
        updates: [text(SHOTS_LINES.slice(0, 2).join('\n')), text(SHOTS_LINES.slice(0, 4).join('\n')), text(SHOTS_LINES.slice(0, 6).join('\n'))],
        during: (s) => {
          s.label('bash-live').emit({ type: 'tool_execution_update', toolCallId: shots.id, toolName: 'bash', args: shots.arguments, partialResult: text(SHOTS_LINES.slice(0, 7).join('\n')) }, 400)
        }
      }),
      b.tool(test, text(TEST_OUT), { durationMs: 6_100, isError: true }),
      b.tool(readFile, text(`${TREE_OLD}\n\n[214 more lines in file. Use offset=121 to continue.]`), { durationMs: 14 }),
      b.tool(readImage, { content: [{ type: 'text', text: 'Read image file [image/svg+xml]' }, { type: 'image', data: screenshot(), mimeType: 'image/svg+xml' }], details: {} }, { durationMs: 22 })
    ]
    return { message, results }
  })
  b.turn(() => {
    const edit = call('edit', { path: 'src/renderer/features/inspector/SessionTree.tsx', edits: [{ oldText: TREE_OLD, newText: TREE_NEW }] })
    const write = call('write', { path: 'docs/tree-anchoring.md', content: NOTES_MD })
    const grep = call('grep', { pattern: 'scrollToIndex', path: 'src/renderer/features/inspector' })
    const find = call('find', { pattern: '**/*.test.ts', path: 'src' })
    const ls = call('ls', { path: 'src/renderer/features/inspector' })
    const message = b.assistant([{ text: 'Keeping the selected node in view instead of jumping to the top.' }, { tool: edit }, { tool: write }, { tool: grep }, { tool: find }, { tool: ls }])
    const results = [
      b.tool(
        edit,
        { content: [{ type: 'text', text: `Successfully replaced 1 block(s) in src/renderer/features/inspector/SessionTree.tsx.\n\n${LENS_STOP}` }], details: { diff: displayDiff(TREE_OLD, TREE_NEW), firstChangedLine: 4 } },
        { durationMs: 1_240 }
      ),
      b.tool(write, text(`Successfully wrote ${NOTES_MD.length} bytes to docs/tree-anchoring.md\n\n\u2713 Markdown clean \u00b7 41ms`), { durationMs: 96 }),
      b.tool(grep, text('SessionTree.tsx:88:    virtualizer.scrollToIndex(index, { align: "auto" })\nBranchesTab.tsx:142:  tree.scrollToIndex(0)\nBranchesTab.tsx:207:  tree.scrollToIndex(focusIndex)'), { durationMs: 38 }),
      b.tool(find, text('src/shared/subagents.test.ts\nsrc/renderer/features/tools/tool-utils.test.ts\nsrc/renderer/features/chat/transcript-items.test.ts'), { durationMs: 52 }),
      b.tool(ls, text('BranchesTab.tsx\nInspector.tsx\nSessionTree.tsx\nTreeList.tsx\nindex.ts'), { durationMs: 6 })
    ]
    return { message, results }
  })
  b.turn(() => {
    const diagnostics = call('lens_diagnostics', { source: 'lsp', scope: 'paths', paths: ['src/renderer/features/inspector/SessionTree.tsx', 'src/renderer/features/inspector/TreeList.tsx'], waitMs: 4000, severity: 'error' })
    const symbol = call('read_symbol', { path: 'src/renderer/features/inspector/TreeList.tsx', symbol: 'TreeList' })
    const report = call('module_report', { path: 'src/renderer/features/inspector/SessionTree.tsx', view: 'exports', focus: 'SessionTree' })
    const nav = call('lsp_navigation', { operation: 'references', path: 'src/renderer/features/inspector/SessionTree.tsx', query: 'SessionTree' })
    const ast = call('ast_grep_search', { pattern: 'scrollTo({ top: 0 })', lang: 'tsx', paths: ['src/renderer'], maxMatches: 20 })
    const mark = call('lens_diagnostic_mark', { filePath: 'src/renderer/features/inspector/TreeList.tsx', line: 61, message: 'Effect has a missing dependency', rule: 'react-hooks/exhaustive-deps', disposition: 'accepted', reason: 'The ref is stable.' })
    const message = b.assistant([{ text: 'Checking the inspector with the language server.' }, { tool: diagnostics }, { tool: symbol }, { tool: report }, { tool: nav }, { tool: ast }, { tool: mark }])
    const results = [
      b.tool(
        diagnostics,
        {
          content: [{ type: 'text', text: '2 files checked: 1 error in SessionTree.tsx.' }],
          details: {
            filesChecked: 2,
            totalDiagnostics: 1,
            cleanFiles: 1,
            unconfirmedFiles: 0,
            timedOutFiles: 0,
            outcomes: [
              { file: 'src/renderer/features/inspector/SessionTree.tsx', outcome: 'diagnostics' },
              { file: 'src/renderer/features/inspector/TreeList.tsx', outcome: 'clean' }
            ],
            diagnostics: [{ file: 'src/renderer/features/inspector/SessionTree.tsx', line: 112, message: "Argument of type 'string | undefined' is not assignable to parameter of type 'string'." }]
          }
        },
        { durationMs: 2_310 }
      ),
      b.tool(symbol, { content: [{ type: 'text', text: 'export const TreeList = forwardRef<HTMLDivElement, TreeListProps>(function TreeList(props, ref) {\n  …\n})' }], details: { found: true, name: 'TreeList', kind: 'function', startLine: 24, endLine: 96 } }, { durationMs: 180 }),
      b.tool(report, { content: [{ type: 'text', text: '## SessionTree.tsx\n\nExports: `SessionTree`, `SessionTreeProps`.' }], details: { available: true, staleness: 'fresh', symbols: 9, exports: 2, callbacks: 3, view: 'exports' } }, { durationMs: 240 }),
      b.tool(nav, { content: [{ type: 'text', text: '[{"path":"src/renderer/features/inspector/BranchesTab.tsx","line":18},{"path":"src/renderer/features/inspector/Inspector.tsx","line":44}]\nresult ok\nusage tokens=212' }], details: { operation: 'references', supported: true, resultCount: 2 } }, { durationMs: 310 }),
      b.tool(
        ast,
        {
          content: [{ type: 'text', text: '2 matches' }],
          details: {
            matchCount: 2,
            totalMatches: 2,
            truncated: false,
            matchLocations: [
              { file: 'src/renderer/features/inspector/BranchesTab.tsx', line: 142 },
              { file: 'src/renderer/features/chat/Transcript.tsx', line: 318 }
            ]
          }
        },
        { durationMs: 420 }
      ),
      b.tool(mark, { content: [{ type: 'text', text: 'Marked TreeList.tsx:61 as accepted.' }], details: { anchor: 'TreeList.tsx:61:react-hooks/exhaustive-deps', disposition: 'accepted', line: 61 } }, { durationMs: 12 })
    ]
    return { message, results }
  })
  b.turn(() => {
    const enable = call('web_enable', {})
    const search = call('web_search', { queries: ['electron File.path removed getPathForFile', 'electron drag and drop folder path'], numResults: 5 })
    const fetch = call('fetch_content', { urls: FETCH_URLS })
    const todo = call('todo', { action: 'create', subject: 'Keep the forked node selected', description: 'Anchor the tree on the selected node after a fork.' })
    const recall = call('history_recall', { query: 'tree scroll anchoring decision' })
    const message = b.assistant([{ text: 'Confirming the Electron change upstream and noting the follow-up.' }, { tool: enable }, { tool: search }, { tool: fetch }, { tool: todo }, { tool: recall }])
    const results = [
      b.tool(enable, { content: [{ type: 'text', text: 'Enabled: web_search, fetch_content.' }], details: { enabled: ['web_search', 'fetch_content'] } }, { durationMs: 4 }),
      b.tool(search, { content: [{ type: 'text', text: SEARCH_ANSWER }], details: { queries: ['electron File.path removed getPathForFile', 'electron drag and drop folder path'], totalResults: 9 } }, { durationMs: 2_840 }),
      b.tool(
        fetch,
        {
          content: [{ type: 'text', text: `Fetched 3 of 8 URLs (14,212 chars). 5 failed: 403 Forbidden or timed out.` }],
          details: { urlCount: 8, successful: 3, totalChars: 14_212 }
        },
        { durationMs: 6_480 }
      ),
      b.tool(
        todo,
        {
          content: [{ type: 'text', text: 'Created task #3.' }],
          details: {
            tasks: [
              { id: 1, subject: 'Reproduce the jump with the parity script', status: 'completed' },
              { id: 2, subject: 'Fix scroll anchoring in SessionTree', status: 'completed' },
              { id: 3, subject: 'Keep the forked node selected', status: 'pending', description: 'Anchor the tree on the selected node after a fork.' }
            ],
            nextId: 4
          }
        },
        { durationMs: 8 }
      ),
      b.tool(recall, { content: [{ type: 'text', text: 'Decided on 2 May: anchor on the selected row, never on scroll offset.' }], details: { matches: 1 } }, { durationMs: 64 })
    ]
    return { message, results }
  })
  b.turn(() => {
    const dev = call('bash', { command: 'npm run dev', timeout: 0 })
    const message = b.assistant([{ text: 'Starting the dev server to check it by hand.' }, { tool: dev }])
    const result = b.tool(dev, text(DEV_OUT), { durationMs: 4_000, isError: true, updates: [text(DEV_OUT.replace('\n\nCommand aborted', ''))] })
    return { message, results: [result] }
  })
  b.turn(() => ({ message: b.assistant([{ text: 'The tree keeps the selected node in view now. One test still fails, and the edit left three lens issues to fix.' }], 'stop'), results: [] }))
}

/** Subagent rows and notices, from the `subagents` script fixtures (same run ids and agents). */
function delegation(b: ScriptBuilder, ctx: ScriptContext): void {
  const timeoutMs = 1_800_000
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user('Hand the tree fix to a worker and get the tool rows reviewed.')
    const worker = call('subagent', { agent: 'worker', model: 'anthropic/claude-opus-5-5:high', cwd: WORKSPACE, async: true, task: WORKER_TASK, options: { timeoutMs } })
    const reviewer = call('subagent', { agent: 'reviewer', cwd: WORKSPACE, async: true, task: REVIEWER_TASK, output: 'reports/r1-code.md' })
    const scout = call('subagent', { agent: 'scout', async: false, task: 'List every place the inspector scrolls the tree. Answer with file:line and one sentence each.' })
    const message = b.assistant([{ text: 'A **worker** takes the tree fix, a **reviewer** the tool rows; a quick **scout** maps the scroll calls first.' }, { tool: worker }, { tool: reviewer }, { tool: scout }])
    const scoutOutput = 'Three places scroll the tree:\n\n- `SessionTree.tsx:88` scrolls the virtualizer to the selected index.\n- `BranchesTab.tsx:142` resets to the top on every refresh.\n- `BranchesTab.tsx:207` follows keyboard focus.'
    const results = [
      b.tool(worker, { content: text(launchText('worker', RUN_IDS.worker)).content, details: launchDetails(RUN_IDS.worker, worker.id, timeoutMs, ctx.now + timeoutMs) }, { durationMs: 1_840 }),
      b.tool(reviewer, { content: text(launchText('reviewer', RUN_IDS.reviewer)).content, details: launchDetails(RUN_IDS.reviewer, reviewer.id, timeoutMs, ctx.now + timeoutMs) }, { durationMs: 1_210 }),
      b.tool(
        scout,
        {
          content: [{ type: 'text', text: scoutOutput }],
          details: {
            mode: 'single',
            results: [
              {
                agent: 'scout',
                task: scout.arguments.task,
                exitCode: 0,
                finalOutput: scoutOutput,
                model: 'anthropic/claude-haiku-4-5',
                usage: { input: 12_400, output: 820, cacheRead: 30_100, cacheWrite: 0, cost: 0.02, turns: 4 },
                progress: { status: 'completed', toolCount: 6, turnCount: 4, durationMs: 18_400 }
              }
            ]
          }
        },
        { durationMs: 18_400 }
      )
    ]
    return { message, results }
  })
  b.turn(() => {
    const steer = call('subagent', { action: 'steer', id: RUN_IDS.worker, message: STEER_MESSAGE, options: { index: 0 } })
    const status = call('subagent', { action: 'status', id: RUN_IDS.worker })
    const list = call('subagent', { action: 'list' })
    const command = call('subagent', { action: 'command.status', id: RUN_IDS.worker, options: { index: 0 } })
    const message = b.assistant([{ tool: steer }, { tool: status }, { tool: list }, { tool: command }])
    const steerRequest = '5d0f8f2e-1b7a-4c53-9a37-6f0c2a4e8b11'
    const results = [
      b.tool(
        steer,
        {
          content: [{ type: 'text', text: steerText(RUN_IDS.worker, steerRequest, STEER_MESSAGE) }],
          details: { mode: 'management', results: [], steering: { requestId: steerRequest, state: 'pending', deliveryStatus: 'queued', sourceRunId: RUN_IDS.worker, targets: [{ index: 0, state: 'queued' }] } }
        },
        { durationMs: 40 }
      ),
      b.tool(status, { content: [{ type: 'text', text: statusText(RUN_IDS.worker) }], details: { mode: 'single', runId: RUN_IDS.worker, results: [], lifecycleStatus: { processTerminal: { state: 'pending' } } } }, { durationMs: 60 }),
      b.tool(list, { content: [{ type: 'text', text: '## Agents\n\n- **worker**: implements a scoped change in a worktree\n- **reviewer**: reviews a diff and writes findings\n- **scout**: fast read-only exploration' }], details: { mode: 'management', results: [] } }, { durationMs: 20 }),
      b.tool(command, text('No command controller is available for this child. Command controls require a local native Pi child with bash.'), { durationMs: 15, isError: true })
    ]
    return { message, results }
  })
  b.turn(() => {
    // The parent reads the runs' output logs from the shell, as a real session does (forward slashes, quoted).
    const workerLog = `${asyncDir(RUN_IDS.worker).replace(/\\/g, '/')}/output-0.log`
    const reviewerLog = `${asyncDir(RUN_IDS.reviewer).replace(/\\/g, '/')}/output-0.log`
    const peek = call('bash', { command: `sleep 30; tail -c 300 "${workerLog}"; echo; tail -c 200 "${reviewerLog}"`, timeout: 60 })
    const mixed = call('bash', { command: `git log --oneline -3; tail -c 400 "${workerLog}"`, timeout: 15 })
    const errors = call('bash', { command: 'npm run typecheck 2>&1 | grep -c error', timeout: 300 })
    const message = b.assistant([{ text: 'Checking their output while the typecheck runs.' }, { tool: peek }, { tool: mixed }, { tool: errors }])
    const results = [
      b.tool(peek, text('read SessionTree.tsx\nedit SessionTree.tsx (+6 \u22122)\nbash npm run typecheck\n\nread ToolRow.tsx\ngrep "data-tool-row"'), { durationMs: 30_040 }),
      b.tool(mixed, text('4f1f9c1 tree: keep the forked node in view\nb49b451 tools: one row per call\n1834ddd chat: thinking chips\nedit SessionTree.tsx (+6 \u22122)'), { durationMs: 42 }),
      b.tool(errors, text('0\n\nCommand exited with code 1'), { durationMs: 3_210, isError: true })
    ]
    return { message, results }
  })
  b.turn(() => ({ message: b.assistant([{ text: 'Both are running in the background; I will pick up their results when they report back.' }], 'stop'), results: [] }))
  settle(b)

  // The worker asks a question and runs a long bash call; the parent is woken and asks the user.
  customMessage(b, 'subagent_supervisor_request', supervisorRequestContent(RUN_IDS.worker), supervisorRequestDetails(RUN_IDS.worker), ctx.now)
  const notice = controlNotice(RUN_IDS.worker, ctx.now)
  customMessage(b, 'subagent_control_notice', notice.content, notice.details, ctx.now)
  b.label('needs-decision').emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(PARENT_WAKE_TEXT)
    return { message: b.assistant([{ text: 'The worker needs your call on the bridge change (option A or B). Its long bash call is the test run, so I am leaving it alone.' }], 'stop'), results: [] }
  })
  settle(b)

  // The user answers from the card: the reply prompt, then the parent relays it.
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(supervisorReplyPrompt({ requestId: REQUEST_ID, agent: 'worker' }, SUPERVISOR_REPLY))
    const reply = call('subagent_supervisor', { action: 'reply', replyTo: REQUEST_ID, message: SUPERVISOR_REPLY })
    const message = b.assistant([{ tool: reply }])
    const result = b.tool(reply, { content: [{ type: 'text', text: `Replied to supervisor request ${REQUEST_ID}.` }], details: { replyTo: REQUEST_ID, runId: RUN_IDS.worker, agent: 'worker' } }, { durationMs: 30 })
    return { message, results: [result] }
  })
  b.turn(() => ({ message: b.assistant([{ text: 'Sent your answer to the worker.' }], 'stop'), results: [] }))
  settle(b)

  // Completion and failure, then the wake: the parent revives the worker and waits for it.
  customMessage(b, 'subagent-notify', notifyCompleted('reviewer', RUN_IDS.reviewer, REVIEWER_SUMMARY, REVIEWER_OUTPUT_PATH), notifyDetails('reviewer', RUN_IDS.reviewer, 'completed', 631_000), ctx.now)
  customMessage(b, 'subagent-notify', notifyFailed('worker', RUN_IDS.worker, timeoutMs), notifyDetails('worker', RUN_IDS.worker, 'failed', timeoutMs - 279), ctx.now)
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(PARENT_WAKE_TEXT)
    const resume = call('subagent', { action: 'resume', id: RUN_IDS.worker, message: RESUME_MESSAGE, options: { timeoutMs: 5_400_000 } })
    const message = b.assistant([{ text: 'The reviewer is done. The worker hit its timeout, so I am reviving it with a checkpoint note.' }, { tool: resume }])
    const result = b.tool(
      resume,
      {
        content: [{ type: 'text', text: resumeText(RUN_IDS.worker, RUN_IDS.resumed) }],
        details: { mode: 'single', runId: RUN_IDS.resumed, results: [], asyncId: RUN_IDS.resumed, asyncDir: asyncDir(RUN_IDS.resumed), context: 'fresh', timeoutMs: 5_400_000, sourceLaunchContractDigest: 'c0b6650d1df3cea2' }
      },
      { durationMs: 900 }
    )
    return { message, results: [result] }
  })
  b.turn(() => {
    const wait = call('bg_wait', { timeoutMs: 600_000 })
    const message = b.assistant([{ tool: wait }])
    const result = b.tool(
      wait,
      {
        content: [{ type: 'text', text: `Async run ${RUN_IDS.resumed} (worker) completed.` }],
        details: {
          wait: { reason: 'window_elapsed', timedOut: false, activeRunIds: [] },
          completions: [{ runId: RUN_IDS.resumed, agent: 'worker', mode: 'single', state: 'complete', success: true, archivePath: asyncDir(RUN_IDS.resumed), results: [{ agent: 'worker', runId: RUN_IDS.resumed, success: true, model: 'anthropic/claude-opus-5-5' }] }]
        }
      },
      { durationMs: 64_000 }
    )
    return { message, results: [result] }
  })
  b.turn(() => ({ message: b.assistant([{ text: "Both are done: the tree keeps the forked node selected, and the reviewer's three findings are in `reports/r1-code.md`." }], 'stop'), results: [] }))
  settle(b)
}
