# QA harness

End-to-end QA of the real app and both bundled engines with local, scriptable providers. These
fixtures control model replies and inspect native requests without paid inference. Explicit real-provider
suites have separate opt-in requirements. See [UPSTREAM.md](../../UPSTREAM.md) for native qualification.

```
npm run build          # suites drive the BUILT app in out/
npm run qa             # every scripts/qa/**/*.qa.mjs, one Node process per suite
npm run qa:smoke       # only smoke.qa.mjs
npm run qa -- --only "settings/**"   # glob on the path or file name (repeatable)
node scripts/qa/settings/thinking.qa.mjs   # one suite directly
```

## Rules

- **Never write to real agent directories** (`~/.pi/agent` or `~/.prime/agent`). Fake mode uses a temp
  `PI_CODING_AGENT_DIR` from `createAgentDir()` and a separate `PRIME_AGENT_CODING_AGENT_DIR` with
  temporary session/kernel roots. The harness refuses account paths outside the QA temp root.
- **Temp folders live outside the user's profile and outside any git repo** (`lib/tmp.mjs`,
  `QA_TMP_ROOT`, default `<repo>/../.vengeance-qa-tmp` on Windows, `/private/tmp/vq` on macOS and
  `/tmp/vq` on Linux, short enough for Engine 2's Unix sockets). The engine treats
  `.agents/skills` in any ancestor of a workspace as project resources (Trust dialog), so
  workspaces never sit below the profile; a git-ignored folder would hide workspace files from
  `git ls-files` (@-mentions).
- **Fake mode runs the app with a temp `HOME`**, so the user's own `~/.agents/skills` never load
  (Electron's `app.getPath('home')` still follows USERPROFILE). Real mode keeps the real HOME.
  `scripts/qa/shell/harness-isolation.qa.mjs` checks both.
- **REAL mode only for tiny prompts** (`"Reply with exactly: ok"`). It runs against the user's real
  engine config with `--no-session` in a temp workspace; `send()` rejects prompts over 80 chars.
  Never copy, read or print `auth.json`: the user's providers are OAuth (anthropic, openai,
  openai-codex) and refresh tokens rotate.
- **Suites live in `scripts/qa/<domain>/<name>.qa.mjs`**. Shared helpers only in `scripts/qa/lib/`.
- The user may have their own Vengeance open. The harness never touches processes it did not start.
- Every harness launch adds the host's Chromium switches from `lib/platform.mjs`: Linux uses the
  basic password store (and `--no-sandbox` only when CI runs as root), macOS the mock Keychain.
  Without OS encryption Linux keeps launch env values plain at rest, so the sealing assertions in
  `settings/launch-options.qa.mjs` and `settings/app-prefs-restart.qa.mjs` check that fallback.
  App shortcuts are pressed as `ControlOrMeta+…` (⌘ on macOS); Linux CI runs under a 2560x1440
  virtual display so the largest responsive shots fit.
- Run native Rust qualification and package builds serially on memory-constrained machines.
  `QA_NATIVE_JOBS=1` limits the native workspace runner; `VENGEANCE_NATIVE_BUILD_JOBS=1` limits
  Engine 2 and helper package builds. Both accept 1–32 jobs and default to four. For native tests,
  `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0` omits debug symbols while keeping test
  assertions, reducing GNU linker memory use on Windows.
- The Engine workspace runner builds the locked `packages/env` Rust daemon before the full suite
  or a targeted `env` run, matching upstream CI. `QA_NATIVE_JOBS` also limits this prerequisite.
  The standalone Env package is outside the bundled SDK's runtime dependency graph.
  On Windows the isolated runner adds Git Bash utilities to its child PATH, including targeted runs
  launched from PowerShell.
- Native workspace runners default to a 15-minute process deadline. `QA_NATIVE_TIMEOUT_MS` sets
  that deadline in milliseconds for a slower qualification host. Both runners accept integers from 1
  through 2147483647, the Node timer limit. This changes the outer process deadline only; native
  test assertions and their time limits still apply.
- Finish renderer builds before launching QA. Run GUI suites serially: rebuilding `out/` beneath a
  running app can invalidate lazy chunks, and concurrent UI suites can compete for focus. Inspect
  failure PNGs and renderer-error output; `scripts/shots.mjs` reports errors even on scenario failure.
- Format touched suites with `npx prettier --write <files>` (config: `scripts/qa/.prettierrc.json`).

## A suite

```js
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'

await runSuite(
  'thinking-high',
  async ({ server, app, step }) => {
    await step('open', () =>
      app.openWorkspace({
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, thinking: 'high' }
      })
    )
    await step('high sends a 16384-token budget', async () => {
      const from = server.requests.length
      server.queue(turn.thinking('hmm', 'done'))
      await app.send('go')
      await app.waitForSettle()
      const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
      assert.equal(sent.thinking.budget_tokens, 16384)
    })
  },
  { agentDir: { settings: { retry: { baseDelayMs: 100 } } } }
)
```

`runSuite` starts the fake LLM, writes the temp agent dir, launches the app, prints each `step`,
saves `<name>-FAILED.png` and the last requests (auth redacted) on failure, always cleans up, and
sets the exit code. Use the libs directly when a suite needs several apps or agent dirs.

## API

### `lib/suite.mjs`

```ts
runSuite(name: string, body: (ctx: { server, agentDir, app, step }) => Promise<void>, options?: {
  mode?: 'fake' | 'real'                 // default 'fake'; server/agentDir are null in 'real'
  agentDir?: CreateAgentDirOptions        // minus `server`
  launch?: LaunchAppOptions               // minus `mode`, `agentDir`
}): Promise<void>
step<T>(label: string, action: () => Promise<T>): Promise<T>
```

### `lib/fake-llm.mjs`

```ts
startFakeLlm(options?: { fallback?: FakeTurn }): Promise<FakeLlm>   // 127.0.0.1, random port

FakeLlm {
  url: string; anthropicBaseUrl: string; openaiBaseUrl: string      // openai = url + '/v1'
  requests: FakeRequest[]                                           // every request, in order
  queue(...turns: (FakeTurn | FakeTurn[])[]): void                  // answered in order
  pending(): number                                                 // queued turns left
  setFallback(turn: FakeTurn): void                                 // default: turn.text('ok')
  setAccountModels(ids | null, { hidden?, serviceTiers? })          // GET /v1/models (ChatGPT catalog);
                                                                    // serviceTiers: slug → [{ id, name, description }]
  reset(): void                                                     // queue + requests + fallback
  waitForRequest(predicate?, { from?: number, timeoutMs?: number }): Promise<FakeRequest>
  waitForOutcome(request, { timeoutMs? }): Promise<'completed' | 'error' | 'aborted'>
  close(): Promise<void>
}

FakeTurn {
  text?: string; thinking?: string                       // streamed thinking → text → tool calls
  toolCalls?: { name: string, args?: object, id?: string }[]
  chunkSize?: number                                     // chars per delta, default 16
  delayMs?: number                                       // before every delta, default 0
  usage?: { input?, output?, cacheRead?, cacheWrite? }   // default: estimated (chars / 4)
  stopReason?: 'stop' | 'length' | 'toolUse'             // default: toolUse when toolCalls
  error?: { status, message?, body?, retryAfter?, headers? }  // HTTP error instead of a stream
  hang?: boolean                       // stream thinking/text, then hold until the engine aborts
  serviceTier?: string | true          // openai-responses: `service_tier` echo (true: the request's, or 'default')
  speed?: string | true                // anthropic-messages: `usage.speed` (true: the request's, or 'standard')
  when?: (request: FakeRequest) => boolean               // only answer matching requests
}

turn.text(text, options?)            turn.thinking(thinking, text, options?)
turn.toolCall(name, args?, options?) turn.toolCalls([{ name, args, id? }], options?)
turn.error(status, { message?, body?, retryAfter?, headers?, ...options })
turn.hang(options?)                  // e.g. turn.hang({ text: 'partial answer' })

FakeRequest {
  index; api: 'anthropic-messages' | 'openai-completions' | 'openai-responses' | null; method; path
  headers                      // ALL headers incl. x-api-key / authorization: memory only
  body                         // parsed JSON, exactly what the engine sent
  receivedAt; turn; outcome: 'streaming' | 'completed' | 'error' | 'aborted'
}

inspectRequest(request) → {
  api, model, maxTokens, temperature,
  thinking,            // anthropic body.thinking, e.g. { type: 'enabled', budget_tokens: 2048 }
  reasoningEffort,     // openai body.reasoning_effort, e.g. 'low'
  system, tools: string[], lastUserText, imageCount,
  messages: { role, text, thinking?, images, toolCalls?, toolCallId?, isError? }[],
  toolResults: { role: 'toolResult', toolCallId, text, images, isError? }[]
}
describeRequest(request)   // copy with auth headers redacted, safe to print
API = {
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  responses: 'openai-responses'
}
```

### `lib/agent-dir.mjs`

```ts
createAgentDir({ server, settings?, models?, provider?, files? }): Promise<AgentDir>
  // settings.json = { defaultProvider: 'qa', defaultModel: 'qa-reasoning', ...settings }
  // models.json   = providers.qa { baseUrl, api: anthropic-messages, apiKey, models, ...provider }
  // files         = extra files, relative path → text or JSON (mcp.json, extensions/…, skills/…)
AgentDir { dir, path(rel), writeText(rel, textOrJson), readText(rel), readJson(rel), cleanup() }

FAKE_PROVIDER = 'qa'
FAKE_MODELS = {
  reasoning: 'qa-reasoning',  // anthropic, reasoning, levels off…high, 200k ctx
  vision:    'qa-vision',     // anthropic, text + image input, 200k ctx
  small:     'qa-small',      // anthropic, 32k ctx (compaction tests)
  openai:    'qa-openai'      // openai-completions, reasoning_effort + image, honors samplingParams
}
FAKE_API_KEY = 'qa-fake-key'
defaultFakeModels(server): object[]          // copy, change, pass back as `models`
assertTempPath(path)   // throws unless inside QA_TMP_ROOT (or the OS temp folder) and outside REAL_AGENT_DIR
REAL_AGENT_DIR         // ~/.pi/agent
```

### `lib/tmp.mjs`

```ts
QA_TMP_ROOT                          // env QA_TMP_ROOT, default per OS (see Rules)
REAL_HOME                            // os.homedir() of the harness process
qaTempDir(prefix): Promise<string>   // <QA_TMP_ROOT>/<prefix>XXXXXX
tempRoot(prefix?): Promise<{ dir, path(...parts), folder(name, files?), cleanup() }>
assertOutsideRealHome(path)          // throws for any path inside REAL_HOME
isInside(parent, child): boolean
```

### `lib/steps.mjs`, `lib/main-stubs.mjs`, `lib/processes.mjs`

```ts
softSteps(step, { app?, name? }): { check(label, action), finish() }
  // a failing check is recorded (with a screenshot) and the suite goes on; finish() fails once

answerSaveDialog(app, filePath | null); saveDialogCalls(app)    // dialog.showSaveDialog
answerOpenDialog(app, path | null)                              // dialog.showOpenDialog
stubShare(app, readiness?); shareCalls(app)                     // share upload, recorded
recordTrash(app); trashCalls(app)                               // shell.trashItem, recorded
stubMainNetwork(app, [{ prefix, json, status? }])               // main fetch + openExternal

processTable(): Promise<{ pid, ppid, name, commandLine, workingSetBytes, createdMs }[]>
descendants(table, pid)                                         // live descendants (PID-reuse safe)
isAlive(pid); killTree(pid); pidsOfImage(imageName)
```

`stubMainNetwork` replaces the main process's `fetch` only. The Engine's SDK host (a node child of main) has its own
`fetch` and inherits main's environment when it starts: its network calls (the ChatGPT account's `GET /models`,
`npm view` and package update checks) are not stubbed. Point them at the fake server instead (the provider's
`baseUrl` in the agent dir, `npm_config_registry`), and change environment variables such as `PI_OFFLINE` only
through `launchApp({ env })`, since a variable deleted in main later does not reach a host that already runs.

### `lib/app.mjs`

```ts
launchApp({ mode?, agentDir?, exe?, outDir?, env?, allowErrors?, size? }): Promise<QaApp>
  // built out/ app, or `exe` (e.g. release/win-unpacked/Vengeance.exe)
  // env: VENGEANCE_TEST=1, VENGEANCE_NO_MICA=1, VENGEANCE_USER_DATA=<temp>, TEMP/TMP=<temp>,
  //      VENGEANCE_MOCK and inherited PI_* / AI_AGENT removed; fake mode also removes PRIME_*.
  //      Fake mode adds temp HOME, PI_CODING_AGENT_DIR, PRIME_AGENT_CODING_AGENT_DIR,
  //      PRIME_AGENT_SESSION_DIR, PRIME_AGENT_CODING_AGENT_SESSION_DIR, PRIME_AGENT_KERNEL_VENV,
  //      PI_OFFLINE=1, PI_SKIP_VERSION_CHECK=1, PI_TELEMETRY=0.
  //      `env: { NAME: undefined }` deletes a variable.

QaApp {
  mode, app (ElectronApplication), page (Page), userData
  openWorkspace({ files?, cwd?, args?: Partial<CreateAgentArgs> }): Promise<{ agentId, cwd }>
    // waits until the new agent is active and its pane is the only visible composer
  createWorkspace(files?): Promise<string>          // temp folder, deleted on close()
  composer(): Promise<Locator>                      // the active session's Message textbox
  send(text): Promise<void>                         // active composer: fill + Enter
  waitForSettle({ timeoutMs? }): Promise<void>      // idle + composer not running + 300 ms quiet
  agentState(agentId?): Promise<AgentState | null>  // renderer store snapshot (active agent)
  appState(): Promise<{ prefs, ui }>
  activeAgentId(): Promise<string | null>
  rpc(command, agentId?): Promise<data>             // engine:command, throws on success:false
  invoke(channel, ...args): Promise<result>         // any IPC channel
  test(method, ...args)                             // any window.__vengeanceTest method
  click(role, name, options?); clickText(text, options?)
  screenshot(name, { settleMs? }): Promise<string>  // <outDir>/<name>.png, default .shots/qa
  errors(): string[]; allowError(pattern: RegExp); assertNoErrors()
  close(): Promise<{ authChanged?: boolean }>
  relaunch(overrides?): Promise<QaApp>              // quit, launch on the same profile/workspaces/HOME
}

reportShotsDir(area): string  // <QA_REPORT_DIR>/<area>-shots, default .shots/qa/<area>-shots
```

`close()` quits the app, kills only its own process tree and engine PIDs if they outlive the quit,
deletes the temp profile and workspaces, and throws on: renderer `console.error`, `pageerror`,
uncaught main-process exceptions or rejections (minus `allowErrors`), a Vengeance.exe that was
running before the launch and is gone now, or (REAL mode) a changed real config file.

At launch the harness checks that the app's userData is the temp folder and that it does not hold
the single-instance lock (`VENGEANCE_TEST=1` skips the lock), so it can run next to the user's own
Vengeance.

### `lib/real-guard.mjs`

```ts
snapshotRealConfig(agentDir = ~/.pi/agent): Promise<{ verify(): Promise<{ authChanged }> }>
  // sha256 + mtime of settings.json, models.json, keybindings.json, mcp.json (those that exist);
  // verify() throws on any change and returns { authChanged } (auth.json: stat only, reported)
REAL_PROMPT_MAX_CHARS = 80
```

`launchApp({ mode: 'real' })` takes the snapshot itself and verifies it in `close()`.

## Recipes

**Assert what a setting sends.** Change the setting through the UI, queue a turn, send, then
`inspectRequest(request)` or the raw `request.body` / `request.headers`. Anthropic thinking budgets
(pi-ai defaults): minimal 1024, low 2048, medium 8192, high 16384, off → `{ type: 'disabled' }`.
On `qa-openai` the level arrives as `reasoning_effort`, and `samplingParams` /
`samplingParamsByThinkingLevel` (set them through `models`) appear as top-level body fields.
Provider `headers` (the `provider` option) arrive in `request.headers`.

**Tool calls.** `turn.toolCalls([{ id: 'toolu_1', name: 'read', args: { path: 'README.md' } }])`,
then a follow-up turn for the answer. The result comes back in the next request:
`inspectRequest(next).toolResults.find((r) => r.toolCallId === 'toolu_1')`. Any tool name works
(built-ins, MCP, extension tools); the engine answers unknown names with an error result.

**Auto-retry.** `turn.error(503)` followed by a normal turn. The engine retries after
`retry.baseDelayMs` (2000 by default; set `settings: { retry: { baseDelayMs: 100 } }`), emitting
`auto_retry_start/end`. Agent-level retry matches the error text (pi-ai `utils/retry.js`): 429,
500, 502, 503, 504, "overloaded", "rate limit", "timeout", "server error"... A plain 400, or a 529
with the default body, is not retried; use `message: 'Overloaded'` for a retryable 529.
`retryAfter` only matters with `retry.provider.maxRetries > 0`: the provider SDK then waits
`retry-after` seconds and retries inside the same turn (no `auto_retry_*` events).

**Errors without retry.** `turn.error(400, { message: 'bad' })` ends the turn with the error message;
`allowError(/…/)` if the app logs it.

**Abort / hang.** `turn.hang({ text: 'partial' })`, wait for the text, click `Stop`, then
`await server.waitForOutcome(request)` → `'aborted'`.

**Auto-compaction.** Use `qa-small` (32k context; triggers when the last usage exceeds
32000 - `compaction.reserveTokens`). The native reserve defaults to 16384, giving a threshold of
15616 tokens; a turn with `usage: { input: 20000 }` crosses it.
Set `settings: { compaction: { keepRecentTokens: 1 } }` so tiny test messages are actually
summarized. The summary requests (one, or two for a split turn) also hit the fake server and get
the fallback answer unless a turn matches them, e.g.
`when: (r) => inspectRequest(r).lastUserText.includes('<conversation>')`. The result lands in
`agentState().lastCompaction`.

**Images.** On `qa-vision`/`qa-openai`, attach through the composer or
`rpc({ type: 'prompt', message, images: [{ type: 'image', data: base64, mimeType }] })`, then
check `inspectRequest(request).imageCount`.

For Engine 2, run `node scripts/qa/engines/image-capabilities.qa.mjs`. It uses the real bundled
GPT 6.1 Sol descriptor and a local provider URL override. It checks native session-state modalities,
model switches in both directions, generated prompts, kernel `model.info`, `attach_image` bytes,
composer warnings, pasted-image transport and vision startup. No real account or paid request is used.

`node scripts/qa/engines/model-isolation.qa.mjs` checks that sibling defaults and a differently
configured native child cannot change the parent's GPT 6.1 Sol / Max / Fast request identity.
It also verifies saved identity/history after restart and preservation of an unfamiliar settings key.
With `QA_PACKAGED_EXE` set, it removes development executable overrides and verifies bundled source.

Dual-engine suites use `scripts/qa/engines/integration-fixture.mjs` for separate native configuration,
local providers, executable identity and cleanup. Do not use pi's `createAgentDir()` format to invent
Prime account/model files. See `integration.qa.mjs` for public-boundary examples.

`node scripts/qa/engines/resident-upgrade.qa.mjs` qualifies attachment to a running older Engine 2
package after selecting the current package. Supply the reviewed baseline's absolute
`QA_PRIME_BASELINE_EXECUTABLE` and exact `QA_PRIME_BASELINE_SHA256`; without both, the historical
suite skips. The successor defaults to the bundled Engine, or uses the reviewed candidate variables
below. It checks the resident's own catalog, custom text-only models with the same ID, live version
notices, app relaunch and explicit restart with saved history and actual tool-image bytes. It records
old native live-switch defects separately from app metadata; app hydration cannot repair that native
binding until the user explicitly restarts the idle resident.

`node scripts/qa/engines/resident-close.qa.mjs` checks Close tab versus Stop session. Idle and working
saved sessions remain available in Background sessions, including future scheduled work. Resume
keeps native identity, worker and history; explicit Stop ends the worker without deleting saved history.

`node scripts/qa/performance/prime-long-history.qa.mjs` transfers 3,000 tool calls through public
engine switching and Engine 2's native session writer. The suite then checks the depth-zero history
through three cold file opens, resident reopens and cached workspace roundtrips. Reports include native
executable identity, open/switch timings, frame gaps, mounted segments, retained renderer/main heap
and zero local-provider requests. Run after native builds and workspace tests finish so CPU contention
does not distort the 8-second open and 2-second cached-switch gates. The shared renderer's
`performance/long-tools.qa.mjs` also checks 1,000, 3,000 and 10,000 tool calls through Engine.

`node scripts/qa/performance/workspace-scale.qa.mjs` checks 8,300 mixed Engine/Engine 2 histories
across 65 workspaces, including search, keyboard navigation, native reopening, hidden workspaces and
heap retention. Run its default full mode for qualification. The depth-zero opening path's zero native
lineage-helper calls are proved separately by `scripts/checks/prime-lineage-binding.check.ts` and
`scripts/checks/prime-saved-sessions.check.ts`; GUI timings do not count helper invocations.

Fast offline `npm run checks` covers exact model identity, explicit text-only overrides and unknown
capabilities. `node scripts/checks/prime-state-model.mjs` drives test-owned native protocol sockets for
attach/resync cursor ordering, stale reply refusal and disconnects during catalog hydration. It launches
no real engine and writes only temporary test registry data.

The native transition suite accepts `QA_PRIME_BASELINE_EXECUTABLE` to qualify a retained complete
package instead of the legacy `.engine-staging/prime/release` slot. Preparing/building the bundled
engines does not create that legacy baseline; select and record one deliberately. The candidate
requires its absolute `QA_PRIME_EXECUTABLE` and exact `QA_PRIME_SHA256`. Both endpoints use temporary
QA account/session storage. Only the resident-upgrade suite additionally requires the baseline hash
as `QA_PRIME_BASELINE_SHA256`; the transition suite computes and records its baseline executable hash.

## Packaged qualification

Build once, then package and test serially from Git Bash:

```sh
npm run build
node scripts/dist-qa.mjs --dir
QA_PACKAGED_EXE='D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe' \
QA_REPORT_DIR='D:/Coding/vengeance/.shots/qa/packaged' \
node scripts/qa/run.mjs --only packaged.qa.mjs --only model-isolation.qa.mjs \
  --only bundled-extensions.qa.mjs
```

Adjust the absolute paths to your checkout. On macOS `QA_PACKAGED_EXE` is the app bundle's
`Contents/MacOS/<name>` executable, on Linux the unpacked folder's lowercase executable. The
basename filter `packaged.qa.mjs` matches both the engine and shell suites, so this command runs
four suites. `QA_PI_PACKAGE_ROOT` optionally points at an installed pi agent directory to copy
compatibility extensions and their dependencies into temporary QA storage; it does not authorize
copying credentials or modifying that source.
The shell suite checks the packaged version against `package.json`, including About and Updates.
The native suite checks both engines, the external bridge and helper loading with a system-only PATH.

## Known limits

- The fake server speaks `anthropic-messages`, `openai-completions` and Responses HTTP/SSE,
  including the native Codex route. Google and Bedrock are not supported. Built-in providers can
  use isolated native URL overrides where their engine exposes them; external OAuth login is not
  performed by these fixtures.
- Mid-stream provider errors are not scriptable (errors are HTTP status responses); `hang` never
  streams tool calls.
- `agentState()` is a JSON copy: `undefined` fields are missing, nothing is live.
- `send()` drives the active agent's composer; with several agents, activate the right one first.
- Packaged mode needs a completed package. Prefer the unpacked QA command above; no installer
  launch is needed. Installer-specific tests use `npm run dist:qa` (appId `com.vengeance.qa`,
  "Vengeance QA", `VengeanceQA.exe`, no shortcuts, separate userData). Never use the production
  installer as a development fixture. Screenshots cannot capture Mica.
