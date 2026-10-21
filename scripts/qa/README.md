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
- **Native worker sockets need a short POSIX temp path.** App launches use isolated `QA_TMP_ROOT`
  as `TMPDIR` on macOS and Linux, rather than nesting it beneath the per-suite app profile. Before
  launch, the harness validates the complete native worker socket's byte budget, including its
  terminator (Darwin 104 bytes; Linux 108). An explicit `TMPDIR` must remain inside `QA_TMP_ROOT`
  and fit that budget. Windows keeps its per-launch temporary directory and named pipes.
- **Fake mode runs the app with a temp `HOME`**, so the user's own `~/.agents/skills` never load
  (on Windows Electron's `app.getPath('home')` still follows USERPROFILE; userData is always the temp
  profile). Real mode keeps the real HOME. `scripts/qa/shell/harness-isolation.qa.mjs` checks both.
- `VENGEANCE_TEST=1` also skips the login-shell environment read on macOS and Linux, so the app's
  children inherit the harness's environment as on Windows. Set the tools a suite needs on the
  harness's own PATH, or through `launchApp({ env })`.
- **REAL mode only for tiny prompts** (`"Reply with exactly: ok"`). It runs against the user's real
  engine config with `--no-session` in a temp workspace; `send()` rejects prompts over 80 chars.
  Never copy, read or print `auth.json`: the user's providers are OAuth (anthropic, openai,
  openai-codex) and refresh tokens rotate.
- **Suites live in `scripts/qa/<domain>/<name>.qa.mjs`**. Shared helpers only in `scripts/qa/lib/`.
- The user may have their own Vengeance open. The harness never touches processes it did not start.
- Every harness launch adds the host's Chromium switches from `lib/platform.mjs`: Linux uses
  `--password-store=basic`, so safeStorage never waits on a desktop keyring, and adds `--no-sandbox`
  and `--disable-dev-shm-usage` only when `CI` runs as root (a container); macOS uses
  `--use-mock-keychain`, so safeStorage never prompts. Windows adds none. The shots harness and
  `scripts/e2e-real.mjs` use the same switches. The shots harness also drops inherited `PI_*`,
  `PRIME_*` and `AI_AGENT` variables, and runs no scenario unless the app's Engine folders are
  inside that scenario file's temp root.
  Without OS encryption Linux keeps launch env values plain at rest, so the sealing assertions in
  `settings/launch-options.qa.mjs` and `settings/app-prefs-restart.qa.mjs` check that fallback.
  App shortcuts are pressed as `ControlOrMeta+…` (⌘ on macOS).
- **Linux needs a display.** On a host without one, run GUI suites and shots under Xvfb, as CI does:
  `xvfb-run -a -s '-screen 0 2560x1440x24' npm run shots` (the largest responsive shots need that
  screen). On Ubuntu 24.04 and newer, AppArmor blocks the user namespaces Chromium's sandbox needs;
  allow them for the session with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
  The harness keeps the app's sandbox on outside root containers.
- Run native Rust qualification and package builds serially on memory-constrained machines.
  `QA_NATIVE_JOBS=1` limits the native workspace runner; `VENGEANCE_NATIVE_BUILD_JOBS=1` limits
  Engine 2 and helper package builds. Both accept 1–32 jobs and default to four. For native tests,
  `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0` omits debug symbols while keeping test
  assertions, reducing GNU linker memory use on Windows.
- **Engine 2 Python-tool suites require uv on PATH.** The first native kernel operation downloads
  Python and kernel packages into isolated QA storage, so it also needs network access even when
  model replies use local providers. Release runners install uv 0.13.1 with the pinned setup-uv
  action and caching disabled. A Python tool or child failure after missing uv is failed setup,
  not evidence that the intended native assertion ran.
- **Intel macOS verifies the loaded Python wheel.** The integration suite starts without a kernel
  cache or kernel-Python override. Its first real Python tool call reports cryptography, its OpenSSL
  backend, the loaded native extension hash, and the installed wheel's `direct_url.json`. These must
  match the packaged wheel manifest and build receipt, and the interpreter and extension must be in
  the fixture's automatic kernel venv. No constraint, wheel-search or dependency override may reach
  that kernel. The receipt is `engines-shots/intel-kernel.json`.
- Prime workspace formatting on Windows runs per-package native checks across the workspace and its
  recursive path dependencies. This keeps full `cargo fmt --all --check` coverage within Windows'
  command-line length limit; other hosts use the single native workspace command.
- The Engine workspace runner builds the locked `packages/env` Rust daemon before the full suite
  or a targeted `env` run, matching upstream CI. `QA_NATIVE_JOBS` also limits this prerequisite.
  The standalone Env package is outside the bundled SDK's runtime dependency graph.
  On Windows the isolated runner adds Git Bash utilities to its child PATH, including targeted runs
  launched from PowerShell; on macOS and Linux it runs upstream's `test.sh` with the system `bash`.
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
  // Windows: CIM through PowerShell; Linux: /proc; macOS: ps (C locale). `name` is the executable's
  // file name: `prime-agent.exe` on Windows, `prime-agent` elsewhere.
descendants(table, pid)                                         // live descendants (PID-reuse safe)
isAlive(pid); pidsOfImage(imageName)                            // e.g. platform.mjs APP_PROCESS_NAME
killTree(pid)   // only trees the harness started: taskkill /T /F on Windows; elsewhere SIGTERM to
                // the whole descendant tree, then SIGKILL after 3 s
processIdentity(pid): Promise<{ pid, parentPid, executablePath }>   // resolved executable path
```

### `lib/platform.mjs`

```ts
ELECTRON_SWITCHES: string[]          // Chromium switches for every launch (see Rules); [] on Windows
executableName(name): string         // `prime-agent` → `prime-agent.exe` on Windows only
APP_PROCESS_NAME: string             // Vengeance.exe | Vengeance (macOS) | vengeance (Linux)
unpackedExecutable(outputDir): string
  // win-unpacked/Vengeance.exe, mac-arm64|mac/Vengeance.app/Contents/MacOS/Vengeance,
  // linux-unpacked|linux-arm64-unpacked/vengeance
resourcesDirOf(executable): string   // process.resourcesPath of a packaged app (macOS: Contents/Resources)
TRASH_NAME: string                   // 'Recycle Bin' on Windows, 'Trash' elsewhere (the app's wording)
DOCUMENT_START_KEY, DOCUMENT_END_KEY: string // Control+Home/End, or Meta+ArrowUp/Down on macOS
```

`stubMainNetwork` replaces the main process's `fetch` only. The Engine's SDK host (a node child of main) has its own
`fetch` and inherits main's environment when it starts: its network calls (the ChatGPT account's `GET /models`,
`npm view` and package update checks) are not stubbed. Point them at the fake server instead (the provider's
`baseUrl` in the agent dir, `npm_config_registry`), and change environment variables such as `PI_OFFLINE` only
through `launchApp({ env })`, since a variable deleted in main later does not reach a host that already runs.

### `lib/app.mjs`

```ts
launchApp({ mode?, agentDir?, exe?, outDir?, env?, allowErrors?, size? }): Promise<QaApp>
  // built out/ app, or `exe`, an unpacked app's executable (platform.mjs unpackedExecutable)
  // env: VENGEANCE_TEST=1, VENGEANCE_NO_MICA=1, VENGEANCE_USER_DATA=<temp>, TEMP/TMP=<temp>,
  //      TMPDIR=<temp> on Windows; the short isolated QA_TMP_ROOT on macOS/Linux (byte-budget checked),
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
uncaught main-process exceptions or rejections (minus `allowErrors`), a Vengeance process
(`APP_PROCESS_NAME`) that was running before the launch and is gone now, or (REAL mode) a changed real
config file. Engine 2 daemon endpoints it cleans up are named pipes on Windows and
`vengeance-engine2-<id>.sock` Unix sockets elsewhere. Each owned daemon gets a shutdown request and
15 s for it and its own exit; a quick exit returns at once. Only a daemon whose creation time proves
its identity is then force-stopped. macOS has no precise creation time, so there cleanup keeps
re-checking the PID's endpoint and executable and waits up to 25 s after the request for the daemon
to exit, then reports it instead of killing it. `scripts/checks/qa-daemon-cleanup.mjs` covers these
paths and runs in release dry runs on every platform.

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

`node scripts/qa/engines/mcp-live.qa.mjs` checks Engine 2's live MCP status with the stdio fixture
server (`ext/fixtures/qa-mcp-server.mjs`) in the temporary account's `mcpServers`. A file in place of
the kernel venv's parent holds the prewarmed kernel off, so the composer chip deterministically reports
configured-only states first. A Python tool call then starts the kernel; the suite checks connected
with the tool count, Reconnect from the chip and from Settings → MCP (each a new server process), and
a second conversation's own kernel. That conversation also runs the fixture with `--hang`, a server
that never answers: it reads as failed with the reason and keeps Reconnect. Engine 2 starts servers
with a cleared environment, so the fixture also takes its start log as `--log=<file>`.

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
suite skips. The successor defaults to the bundled Engine 2, or uses the reviewed candidate variables
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
QA account/session storage. Packaged runs of both transition and resident-upgrade suites require the
baseline's exact `QA_PRIME_BASELINE_SHA256`. A standalone built-app transition computes and records
its baseline hash and validates this variable when supplied. Release upgrade runs use the verified
official-package loader below rather than the legacy slot.

## Packaged qualification

Build once, then package and test serially from Git Bash on Windows (any POSIX shell elsewhere):

```sh
npm run build
node scripts/dist-qa.mjs --dir
export QA_PACKAGED_EXE='D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe'
export QA_TMP_ROOT='D:/Coding/vengeance-qa'
QA_PLATFORM_GROUP=core \
QA_REPORT_DIR="$PWD/.shots/qa/platform" \
node scripts/qa/engines/platform-qualification.mjs
```

Adjust the absolute paths to your checkout. `dist-qa.mjs` ends with a `QA executable: <path>` line
naming the host's `QA_PACKAGED_EXE`, under `release/qa`:

| Host                | `QA_PACKAGED_EXE`                                      |
| ------------------- | ------------------------------------------------------ |
| Windows x64         | `win-unpacked/VengeanceQA.exe`                         |
| macOS Apple silicon | `mac-arm64/VengeanceQA.app/Contents/MacOS/VengeanceQA` |
| macOS Intel         | `mac/VengeanceQA.app/Contents/MacOS/VengeanceQA`       |
| Linux x64           | `linux-unpacked/vengeance-qa`                          |
| Linux arm64         | `linux-arm64-unpacked/vengeance-qa`                    |

The release workflow runs this default `core` group on all five native platforms: packaged,
integration, model-isolation, system-prompts, restart-safety, stop-compaction, bash-queue,
session-recovery and resident-close. On Linux without a display, prefix GUI commands with
`xvfb-run -a -s '-screen 0 2560x1440x24'`.

The runner verifies the QA identity, version, bundled native inventories and loaded resources. Each
suite gets separate temporary accounts and a `packaged-target.json` receipt; missing or mismatched
receipts fail. Its 15-minute per-suite deadline can be set with `QA_PLATFORM_TIMEOUT_MS` (1–2147483647
milliseconds). Cleanup has a 30-second deadline, identifies owned processes before stopping them and
protects pre-existing processes. A failure stops the sequence; a failed cleanup cannot admit another
GUI suite. Evidence is `QA_REPORT_DIR/run-*/qualification.json`, with numbered suite folders containing
`result.json`, `packaged-target.json`, stdout/stderr logs and PNGs. Successful temporary roots are
removed; failed roots remain for diagnosis. In CI, this report root is `$RUNNER_TEMP/engine-qualification`.

Optional compatibility coverage remains separate: use `scripts/qa/run.mjs --only bundled-extensions.qa.mjs`
with `QA_PACKAGED_EXE`. `QA_PI_PACKAGE_ROOT` can select installed compatibility extensions to copy into
temporary storage; the source account and credentials stay untouched.

### macOS background applications

On both macOS architectures, keep `QA_PACKAGED_EXE` set to the QA app and run:

```sh
QA_REPORT_DIR="$PWD/.shots/qa/background-applications" \
  node scripts/qa/engines/background-apps.qa.mjs
```

The OS observer checks application activation policies during real Engine RPC, SDK/provider/CLI work,
Engine 2 and its native helper, and a normal-mode login-shell probe, all using temporary accounts.
The red/green witness must detect the old main-executable child behavior; the main app stays regular
while background work stays out of the Dock. Inspect actual `*-desktop.png` files and
`background-apps-evidence.json` under `QA_REPORT_DIR/background-apps-shots`, alongside page PNGs.
This needs a macOS desktop. CI uses
`$RUNNER_TEMP/background-applications` and temporarily shows the Dock, restoring its preference afterward.

### Official release upgrades

Since 0.3.3, both macOS and both Linux architectures qualify official 0.3.2 Engine 2 `.10` to the final
packaged candidate (`.12` in 0.3.3, `.13` in 0.3.4 to 0.3.6). With the same absolute `QA_PACKAGED_EXE` and
outside-home/repository `QA_TMP_ROOT` exported, run after core qualification and the macOS
visibility check:

```sh
QA_REPORT_DIR="$PWD/.shots/qa/release-baseline" \
  node scripts/qa/engines/release-baseline.mjs
QA_PLATFORM_GROUP=upgrade \
QA_RELEASE_BASELINE_ENV="$PWD/.shots/qa/release-baseline/release-baseline-env.json" \
QA_REPORT_DIR="$PWD/.shots/qa/engine-upgrade" \
  node scripts/qa/engines/platform-qualification.mjs
```

The loader verifies pinned public `SHA256SUMS`, archive hashes, complete native inventories and macOS
signatures, retaining the extracted official package under `QA_TMP_ROOT`. It never launches its
production app. `release-baseline.json` records both packages; `release-baseline-env.json` supplies
the verified `QA_PRIME_BASELINE_EXECUTABLE`, `QA_PRIME_BASELINE_SHA256`,
`QA_PRIME_BASELINE_VISION_SWITCH=working`, `QA_PRIME_EXECUTABLE` and `QA_PRIME_SHA256`.

On Intel macOS, each upgrade fixture first invokes the actual `.10` installer's
`--prime-agent-bootstrap` entry point under temporary HOME, account, cache and kernel directories.
Only that bounded child gets a `UV_CONSTRAINT` file selecting the verified candidate's current
cryptography wheel. The old executable writes its own readiness record. The app qualification then
uses that venv with the constraint and kernel-Python overrides absent; the candidate's wheel-aware
runtime identity must invalidate old readiness and its Python tool must load the packaged extension
and OpenSSL. `baseline-prewarm.json` records bounded command output, and `intel-upgraded-kernel.json`
records the candidate's loaded implementation and readiness. `baseline-inventory.json` records the
complete official engine payload before and after qualification and rejects any mutation. Core
integration always tests fresh candidate bootstrap, without baseline provisioning.

The upgrade group runs candidate-transition and resident-upgrade serially against the packaged QA
candidate and uses the same receipts, deadlines and report layout as core. CI uses
`$RUNNER_TEMP/release-baseline` and `$RUNNER_TEMP/engine-upgrade`. Windows's native `.10` to `.11`
transition has retained PR evidence that predates `.12`; each later candidate needs fresh
qualification. Pi keeps its `v1.3.0` base (`.2` in 0.3.2 and 0.3.3, `.3` in 0.3.4, `.4` in 0.3.5 and 0.3.6), so the
historical pi 1.2 to 1.3 transition fixture is not a release gate.

### Built-app navigation benchmark

After the packaged and applicable upgrade checks, run separately on all five platforms:

```sh
node scripts/perf/first-navigation.mjs --label release-local --runs 3
```

This uses built `out/` and both native engines, not `QA_PACKAGED_EXE`. It retains
`.shots/perf/first-navigation/release-local.json` plus per-sample PNGs and CPU profiles, including
source-bundle/native identities and strict visible-history, syntax and scroll checks. CI labels are
`release-<platform>`. Current-platform samples do not establish an improvement over an unmeasured
baseline. CI uploads all four QA report roots and `.shots/perf/first-navigation` as
`engine-qualification-<platform>`; inspect the PNGs as well as JSON outcomes.

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
  launch is needed. Installer-specific tests use `npm run dist:qa`, which builds the host's packages
  under the QA identity: appId `com.vengeance.qa`, "Vengeance QA", `VengeanceQA.exe` /
  `VengeanceQA.app`, `vengeance-qa` as the Linux executable, package name and desktop entry, no
  shortcuts, separate userData. Production release packages are used only as verified native upgrade
  baselines above; never launch their production app or installer as a fixture. Ordinary suite PNGs
  capture the page only: not Mica, the macOS traffic lights or Electron's Linux caption buttons.
  The macOS background-application observer separately captures the actual desktop.
