// Deterministic content for footprint runs: a long, realistic working session (markdown, code, tool calls with
// sizeable results) and a long streamed answer. Same bytes on every run, so before/after numbers compare.
import { SessionBuilder } from '../../qa/sessions/lib/session-files.mjs'

const TS_SNIPPET = Array.from(
  { length: 28 },
  (_, line) =>
    `  const value${line} = items.filter((item) => item.weight > ${line}).map((item) => ({ ...item, rank: ${line} }))`
).join('\n')

const PY_SNIPPET = Array.from(
  { length: 18 },
  (_, line) => `    total_${line} = sum(row["amount"] for row in rows if row["bucket"] == ${line})`
).join('\n')

function fileText(seed, lines) {
  return Array.from(
    { length: lines },
    (_, line) =>
      `${String(line + 1).padStart(4)}  export function handler${seed}_${line}(input: Request): Response { return route(input, ${line}) }`
  ).join('\n')
}

function bashOutput(seed, lines) {
  return Array.from(
    { length: lines },
    (_, line) => `PASS src/feature-${seed}/case-${line}.test.ts (${(line % 7) + 1}.${line % 10}s)`
  ).join('\n')
}

/** Markdown an assistant would write: headings, prose, a list, a table and code fences. */
export function assistantMarkdown(seed) {
  return [
    `## Step ${seed}: what changed`,
    '',
    `The request handler for area ${seed} now validates its input before routing, so a malformed body returns a`,
    'clear 400 instead of failing deep inside the pipeline. The cache key also includes the tenant, which fixes the',
    'cross-tenant leak reported earlier.',
    '',
    '- Validation happens once, at the edge',
    '- The cache key is `tenant:route:hash`',
    `- ${seed % 3} call sites moved to the new helper`,
    '',
    '| File | Change | Lines |',
    '| --- | --- | --- |',
    `| src/area-${seed}/handler.ts | validate input | +${12 + seed} −4 |`,
    `| src/area-${seed}/cache.ts | tenant in key | +3 −1 |`,
    '',
    '```ts',
    TS_SNIPPET,
    '```',
    '',
    seed % 2 === 0 ? '```python\n' + PY_SNIPPET + '\n```' : 'All tests pass locally.'
  ].join('\n')
}

/**
 * A long working session in `cwd`: `turns` exchanges, each a prompt, a reply with tool calls (read, bash, edit) and
 * their results, then a markdown answer.
 */
export function longSession(
  cwd,
  { turns = 60, name = 'Footprint: long working session', startedAt } = {}
) {
  const session = new SessionBuilder({ cwd, startedAt, stepMs: 400 })
  session.modelChange('qa', 'qa-reasoning')
  for (let turn = 0; turn < turns; turn++) {
    session.user(`Turn ${turn}: tighten the request handling in area ${turn} and run its tests.`)
    const read = `read-${turn}`
    const bash = `bash-${turn}`
    const edit = `edit-${turn}`
    session.assistant(`Looking at area ${turn} first.`, {
      toolCalls: [
        { id: read, name: 'read', args: { path: `src/area-${turn}/handler.ts` } },
        { id: bash, name: 'bash', args: { command: `npm test -- src/area-${turn}` } }
      ]
    })
    session.toolResult(read, 'read', fileText(turn, 60))
    session.toolResult(bash, 'bash', bashOutput(turn, 30))
    session.assistant('Applying the fix.', {
      toolCalls: [
        {
          id: edit,
          name: 'edit',
          args: {
            path: `src/area-${turn}/handler.ts`,
            oldText: `return route(input, ${turn})`,
            newText: `return route(validate(input), ${turn})`
          }
        }
      ]
    })
    session.toolResult(edit, 'edit', `Applied 1 edit to src/area-${turn}/handler.ts`)
    session.assistant(assistantMarkdown(turn))
  }
  session.name(name)
  return session
}

/** A short saved session for history lists. */
export function shortSession(cwd, index, startedAt) {
  const session = new SessionBuilder({ cwd, startedAt, stepMs: 1000 })
  session.user(`History item ${index}: explain the build pipeline`)
  session.assistant(assistantMarkdown(index))
  session.name(`History ${String(index).padStart(3, '0')}: build pipeline notes`)
  return session
}

/** A long streamed answer (about 9,000 characters of mixed markdown). */
export function longAnswer() {
  return Array.from({ length: 6 }, (_, part) => assistantMarkdown(100 + part)).join('\n\n')
}
