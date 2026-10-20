# Vengeance's pi build

Vengeance builds stable `v1.3.0`, commit `71023aec1546d6d677a65669c5665c0927ce0dd0`,
as `1.3.0+vengeance.4`. See [UPSTREAM.md](../../UPSTREAM.md) and
[engines.lock.json](../../engines.lock.json) for the source and maintenance contract.

The active series includes distribution policy (0001), extension runtime version identity (0002),
native runtime qualification (0003), Windows native test fixtures (0005), Abliteration (0006),
native session sharing (0007), POSIX shell test paths (0008), MCP host state (0009) and OAuth
refresh rejection (0010).
Patch `0005` normalizes the external-editor fixture's temporary path on Windows. Patch `0006`
also supplies Abliteration's native default model, required by the 1.3 provider-selection contract.
The series applies to the stable base without source conflict.

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
the pinned catalog files. It supports native API-key login and `ABLIT_KEY`, all three models,
session-affinity headers, current prices and model-specific thinking and image capabilities.
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
`refresh_token_expired`, `refresh_token_reused` or `refresh_token_invalidated`, with HTTP 400 or
401. The credential keeps every field and gains `refreshRejectedAt` (epoch milliseconds) under the
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

The distribution patch refuses native self-updates and suppresses upstream release notifications.
Extension/package updates and model catalog refreshes remain native operations. Built-in extensions,
the CLI, RPC entry and the SDK all come from our source checkout. Internal runtime packages are
packed locally and substituted into upstream's installation lock; external dependencies stay pinned.

The compatibility patch keeps the native package version and SDK `VERSION` at `1.3.0`.
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
