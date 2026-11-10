# Vengeance's pi build

Vengeance builds stable `v1.5.1`, commit `dd30101cfc5b0609411dd80b6f93adbc14db14cf`,
as `1.5.1+vengeance.1`. See [UPSTREAM.md](../../UPSTREAM.md) and
[engines.lock.json](../../engines.lock.json) for the source and maintenance contract.

The active series includes distribution policy (0001), extension runtime version identity (0002),
native runtime qualification (0003), Windows native test fixtures (0005), Abliteration (0006),
native session sharing (0007), POSIX shell test paths (0008), MCP host state (0009), OAuth
refresh rejection (0010), the per-request image limit (0011), OrcaRouter (0012), Audn (0013) and
Claude Fable 5.2 (0014).
Patch `0005` normalizes the external-editor fixture's temporary path on Windows. Patch `0006`
also supplies Abliteration's native default model, required by the 1.3 provider-selection contract.
Rebasing onto 1.4.0 needed two reviewed resolutions: the chord package-boundary test, where 1.4.0's
allow-list and patch `0005`'s portable separator now combine, and the default-model table, where
`0006` adds Abliteration after 1.4.0's `mimo-v2.6-pro` Xiaomi defaults.
Rebasing onto 1.5.0 kept all eleven patches. `0003` combines with upstream's reported editor failures, so
an empty editor command now fails with a message. Upstream now compares `check:entry-graphs` paths in `/`
form, so `0005` dropped that hunk; `0010` keeps upstream's `./models` forbid list and its 21-file budget.
1.5.0's new JSON Schema suite and preview-package test assumed POSIX paths, so `0005` normalizes the
suite's fixture names and reads the packed tarball by relative path, because GNU tar takes a `D:` prefix
for a remote host.

Rebasing onto 1.5.1 (373 upstream commits) kept all thirteen patches; 1.5.1 supplies none of their
behavior. Three resolutions were imports: 1.5.1's tools test imports `symlinkSync` for its new grep glob
case, which `0005`'s `fs/promises` import and `0008`'s `realpathSync` now join, and `0009` imports
`isOAuthServer` beside the MCP runtime's new `sliceTail`. Every other patch applied by three-way merge.
1.5.1's new `refreshModelsAuth: "configured"` catalog refresh, which pi.dev's overlay gives every built-in
provider but Radius and OpenRouter, asks `checkProviderAuth` whether the provider is configured, and `0010`
already answers no for a rejected sign-in, so those refreshes skip it too. 1.5.1 itself only stops
refreshing OAuth for these refreshes and warns about a stale login in `pi update --models`; it still marks
nothing. `0014` also drops one assertion of upstream's new Fable 5.2 case in
`anthropic-mid-conversation-effort.test.ts`, which expects OpenRouter's `anthropic/claude-fable-5.2`: the
pinned catalog lists OpenRouter's Fable 5.1 but not 5.2, so unpatched 1.5.1 fails its own `check` and that
test.

On Windows, seven coding-agent tests fail on both the patched tree and unpatched `v1.5.1` through the same
harness: five new 1.5.1 tests that assume POSIX (file and directory symlinks without symlink privilege in
`auth-storage` and the grep glob case, `SIGTERM` and a `B:` path joined below a folder in
`subagent-extension`), the new compaction-summary transformer case, which expects `1,234` where an
`en-DE` host formats `1.234`, and the earlier directory `chmod` case in `session-manager/file-operations`.
The same seven files fail fourteen tests unpatched; `0005` fixes the other seven. No patch touches the code
these tests exercise.

1.5.1 was qualified on 10 November 2026 against the reconstructed and staged `1.5.1+vengeance.1`, payload
hash `bb62eb8b43bcd50cfc3268836547c9364adb995a31ebc0303a0585066561fdf0`, whose manifest lists this series'
thirteen patch hashes. Native runs set `QA_TMP_ROOT` outside the repository and `QA_PI_SOURCE` to a short
junction to the staged checkout. From an app worktree the default temporary root lies inside the main
checkout, where `resource-loader.test.ts` finds its `AGENTS.md`, and the long source path wraps a width-120
render in `tool-execution-component.test.ts`; those eleven tests fail that way and pass this way.

```text
node scripts/checks/pi-workspace.mjs check
  ✓ isolated native Engine checks passed
node scripts/checks/pi-workspace.mjs
  scripts 61/61, agent 94, ai 1920 (893 skipped), codemode 231, env 99 (20 skipped), evals 54,
  mcp 130 (2 skipped), schema 8744 (9 expected fail), telemetry 52, tui 1303
  chord 55 failed, 3172 passed; coding-agent 7 failed, 3140 passed; durable 2 failed, 1924 passed
node scripts/checks/pi-workspace.mjs durable --config vitest.store.config.ts
  Tests  550 passed | 5 skipped (555)
node scripts/checks/pi-workspace.mjs durable --config test-workers/vitest.config.ts
  Tests  37 passed (37)
node scripts/checks/pi-catalog.mjs
  ✓ native catalog: Haiku capabilities, pricing and Off thinking; Sonnet cache price; Fable 5.2; OrcaRouter; Audn
```

Every failure also fails on unpatched `v1.5.1`, built with `build:offline` and run through the same harness,
which fails more. Chord's 55 are Windows assumptions (POSIX file modes, symlinks, `D:` paths imported as
URLs, file locks and `SIGTERM`); unpatched, it also fails the package-boundary test that `0005` fixes.
Unpatched durable fails seven: `0005` fixes five symlink cases, and the other two, an idle-scope recompute
and a streamed tool-call partial, exceed vitest's five-second timeout on both trees. Its memory-proportion
test failed once on the patched tree and passed in two reruns. Because `npm test` stops durable at its first
failure, the full run skips its later passes. The store and worker passes ran separately above; the
zero-retention pass did not, because the harness strips `PI_` variables.

Patch `0010` raises the `./models` budget from 20 to 21 files for
`auth/oauth-error.ts`, which rejected-refresh recognition adds to that entry.

Patch `0005` also separates Bun result settlement from process exit in the real-worker fixture.
Upstream [issue 10748](https://github.com/earendil-works/pi/issues/10748) documents that Bun can keep
a non-interruptible worker alive after cancellation settles. The fixture reads Bun's result and
terminates its owned process during cleanup; Node still must exit cleanly. Both runtimes keep the
one-second result bound, and Node keeps the one-second exit bound. No runtime code changes.

Patch `0004` is historical and no longer applied. Upstream's content-addressed catalog
`sha256-ffa3e98626230f378f80200debb736c4a2238b5f2ba246a92cfc7d8e19604678`
supplies Claude Haiku 5.5 with its reasoning, vision, context, output and pricing metadata, and
Claude Sonnet 5.5 with the qualified cache-read price. Upstream commit
[`dc93991`](https://github.com/earendil-works/pi/commit/dc93991) also enables Haiku 5.5's supported
Off thinking level. The native catalog supplies these values directly.

Patch `0006` adds the Abliteration provider through native provider and catalog APIs without changing
the pinned catalog files. It supports native API-key login and `ABLIT_KEY`, all four models (Abliterated Model, Large Flash,
Large v2 and the deprecated Large), session-affinity headers, current prices and model-specific
thinking and image capabilities. Chat Completions accepts every `reasoning_effort` from `none` to
`max` on all four (checked against the live API on 26 October 2026); Large v2 cannot turn reasoning
off. Names, limits, image input and prices follow `GET /v1/models`. Abliterated Model and Large Flash
reject a request with more than four images (`400 media_count_exceeded`), so both declare
`images.maxPerRequest: 4`, which patch `0011` applies.
The native `abliteration.test.ts` and `scripts/qa/auth/abliteration.qa.mjs` qualify the integration;
see `UPSTREAM.md` for the provider documentation and retirement criteria.

Patch `0007` exposes the native sharing implementation to RPC and saved-session callers. The terminal
and Vengeance share the same Radius authentication, native session export, gist upload and destination
preference. Readiness uses read-only native authentication and model stores; uploading refreshes native
authentication only after the user requests a link. Settings are reloaded per operation, and the
expected destination prevents an already reviewed share dialog from silently changing upload targets.
Explicit-path HTML exports support native in-memory sessions, allowing saved gist shares without
opening the source session for writing or requiring a currently available model.

Patch `0008` is test-only. Patch `0005` compares the bash tool's `pwd` with the test directory exactly.
POSIX shells report the physical directory, and macOS keeps `tmpdir()` behind the `/var` symlink, so
the fixture compares against the directory's real path off Windows. The shipped payload is unchanged.

Patch `0009` lets a host extension read and drive the built-in MCP extension over the shared extension
event bus. `mcp:state` publishes each server's state, tool count, sign-in requirement and error, and
`mcp:request` answers a state request or runs reconnect, enable, disable or sign-out like `/mcp` and the
MCP manager. Each server also says where enable and disable save (`saves`: the global or project
`mcp.json`, or the session for registered servers) and, for a global server without a project override
in a trusted project, the project `mcp.json` (`projectConfig`) that the `enable-project` and
`disable-project` actions save an override to, like the manager's _Enable in this project_ and
_Disable in this project_. These additions are optional fields and new actions, so the host state stays
version 1. Vengeance's bridge uses it for the conversation's MCP panel and for Reconnect in Settings;
the panel's on/off switch uses the project actions whenever they are offered, so it never changes the
global `mcp.json` for every folder unannounced. Before it, the app could only send `/mcp reconnect` as a
prompt and had no per-server state. The `/mcp` command, notifications and the `mcp_servers` prompt
section are unchanged; the manager shares the rule that decides when a project override is offered.
The native `agent-session-mcp-host-state.test.ts` qualifies the host channels; `agent-session-mcp.test.ts`,
`agent-session-mcp-oauth.test.ts`, `mcp-extension.test.ts`, `mcp-command.test.ts` and
`mcp-manager-view.test.ts` qualify the unchanged behavior. Retire it when upstream offers an
equivalent host-facing state and action interface and the bridge moves to it.

Patch `0010` stops a dead OAuth sign-in from looking signed in. Upstream keeps a credential whose
refresh failed so a retry can succeed, and so it kept counting a provider as available after its
token endpoint had rejected the refresh token: every request, including extensions' choice of "any
signed-in provider" (for example an auto-title model), picked it and failed with another token
request. A refresh by one of the built-in OAuth flows (OpenAI, OpenAI Codex, Anthropic, xAI, Kimi
Code and Radius) now reports a token endpoint error response with a JSON body as
`OAuthEndpointError`, directly or (Anthropic's) as the thrown error's `cause`, with the HTTP status
and the error code: the RFC 6749 `error` string, or the `code` of the `error` object OpenAI's
authorization server sends. Some flows raise it from login too, which never marks a credential. Only
a rejected refresh token marks the stored credential: `invalid_grant`, or OpenAI's
`refresh_token_expired`, `refresh_token_reused` or `refresh_token_invalidated`, with HTTP 400 or 401. The credential keeps every field and gains `refreshRejectedAt` (epoch milliseconds) under the
same credential-store lock as the refresh. Timeouts, network errors, server errors, cancellation,
lock failures and other error codes never mark it. A marked credential leaves its provider
unconfigured, since a stored credential owns its provider and environment keys do not replace it:
`checkAuth`, `getAvailable`, the runtime's availability snapshot (the RPC `get_available_models`,
`/model`, scoped models and extensions' `modelRegistry.getAvailable()`) and catalog refreshes skip
it, and requests fail at once with "Sign-in for <provider> expired ... Sign in again." without
calling the token endpoint. A request that fails on a marked credential waits for a full
availability pass to apply before the failure reaches the caller, unless the request is aborted
first, which ends only the wait; the pass replaces any pass in flight and applies every provider's
model filter, and other OAuth failures leave availability alone. Each process keeps its own
snapshot, so another running process lists the provider until it re-reads availability or reaches
the mark itself, and its requests already fail at once. `ModelRegistry.refreshAvailability()` is
that re-read for extensions (the desktop bridge calls it): it reads every stored credential and
every provider's available models again, with their filters, and resolves once such a pass applied,
without reloading models.json or rebuilding providers, so catalog refreshes in flight keep running.
Prompting or selecting a model of that provider names the expired sign-in instead of a missing API
key. A new login replaces the credential, which clears the mark; upstream builds and older Vengeance
builds ignore the field. The interactive `/login` selector, which Vengeance does not show, infers a
stored credential's type from `isUsingOAuth` and so labels an expired sign-in as a configured API
key. GitHub Copilot, Meta and OpenRouter have no RFC 6749 refresh grant and are unchanged. Lazily
loaded OAuth flows are bundled with their own copy of the error module, so recognition uses a
registered symbol, not `instanceof`. The native `oauth-refresh-rejection.test.ts` (pi-ai),
`model-runtime-oauth-rejection.test.ts` and the expired sign-in case of
`suite/agent-session-prompt.test.ts` qualify it, with the existing OAuth flow, `models-runtime`,
model runtime and model registry suites for the unchanged behavior. Retire it when upstream
recognizes rejected refresh tokens and stops offering their providers.

Patch `0011` applies `inputLimits.images.maxPerRequest`, which upstream only declares. Before each
request `transformMessages` keeps the newest images up to the limit and replaces each run of older
ones in user messages and tool results with "(older image omitted: the model accepts at most N
images per request)". The session history is unchanged. It also updates `docs/models.md`, which said
the limits were not applied. The native `transform-messages-image-limit.test.ts` qualifies it with
the existing image and transform suites. Retire it when upstream applies the limit.

The distribution patch refuses native self-updates and suppresses upstream release notifications.
Extension/package updates and model catalog refreshes remain native operations. Built-in extensions,
the CLI, RPC entry and the SDK all come from our source checkout. Internal runtime packages are
packed locally and substituted into upstream's installation lock; external dependencies stay pinned.

The compatibility patch keeps the native package version and SDK `VERSION` at `1.5.1`.
Some extensions require a dotted upstream release and reject SemVer build metadata. Distribution
identity lives in `package.json`'s `vengeance.version`, the engine manifest and CLI `--version`.
Install-change detection compares the distribution identity, including builds on the same upstream base.

Run `npm run engines:prepare`, export reviewed native edits into the ordered patch series, then
run `npm run build:engines -- --engine=pi`. Source and payload fingerprints prevent accidental
shipping of unexported checkout edits or stale build output. Model data is hydrated from upstream's
content-addressed catalog before the offline build. The complete runtime and MIT license ship
outside ASAR, and Vengeance runs it with Electron's Node runtime.

Requalify package commands, RPC, SDK imports, bridge capabilities, provider behavior and saved
sessions on every upstream upgrade. Native package self-update tests use temporary directories;
app QA uses local providers and separate configuration stores. Never test against real account files.

Patch `0012` adds OrcaRouter's `orca/orcacyber-k3.1-pro` as a native provider with API-key login,
`ORCAROUTER_API_KEY` discovery and a default model. Its ladder is Off, Low, High and Max, the efforts
OrcaRouter documents, so a saved Minimal, Medium or Extra high moves to Low, High or Max. The API
rejects the `developer` role, so instructions stay in `system`. Video input has no Engine input type
and is not declared. Images use the same conservative resize profile as every other vision model.

Patch `0013` adds Audn's `necromicon` as a native provider with API-key login, `AUDN_API_KEY`
discovery and a default model. Its ladder is Low, High and Max, the efforts Audn documents. Reasoning
cannot be turned off, so a saved Off or Minimal moves to Low, Medium to High and Extra high to Max.
The API accepts images but the model ignores them, so the model is declared text-only and the composer
says so. Instructions stay in `system` and the output limit travels as `max_tokens`.

Patch `0014` makes Claude Fable 5.2 (`claude-fable-5-2`, released 9 November 2026) available. 1.5.1 adds
it to the catalog generator ([`0d1793c`](https://github.com/earendil-works/pi/commit/0d1793c)), but the
catalog its release commit pins (`sha256-175c0d73533fad08fdd1554932a4993c37564d2a2ea084cbcc2126772fbf906f`)
still lacks it. pi.dev's runtime catalog listed it later on 10 November, with the same fields as the
patch's entry, so an Engine without the patch shows it only after a catalog refresh, and the subscription
still refuses it. The patch adds the entry beside the catalog's Anthropic models, and the catalog's own
entry of the same id wins once it lists one. It has Fable 5.1's shape at Fable 5.2's prices ($8 and $40
per million input and output tokens, $0.20 cache reads, $10 cache writes), a 1M context and 128k output.
Thinking is adaptive and cannot be turned off, and Opus 5 is the fallback for requests its safety
classifiers refuse.
The subscription refuses Fable 5.2 to a Claude Code identity older than 2.1.290 with
`claude_code_version_too_old` (upstream issues
[11969](https://github.com/earendil-works/pi/issues/11969) and
[11989](https://github.com/earendil-works/pi/issues/11989)), so the patch also raises the OAuth identity from
2.1.280 to 2.1.322, as upstream main does after 1.5.1; 1.5.1 still claims 2.1.280. The native
`anthropic-fable-5-2.test.ts` qualifies the entry, the runtime model list and the OAuth identity, and
upstream's Fable 5.2 case in `anthropic-mid-conversation-effort.test.ts` passes against the entry, apart
from the OpenRouter assertion the patch drops (see the 1.5.1 rebase above); `scripts/checks/pi-catalog.mjs`
checks the staged entry. Retire it when the base's pinned catalog lists Fable 5.2 and its identity is
2.1.290 or newer.
