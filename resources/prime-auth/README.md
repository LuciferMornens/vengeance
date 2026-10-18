# Engine 2 native helper

This helper calls Prime Agent's native authentication, session, resource, and
trace APIs. Vengeance supplies the graphical authentication prompts and saves
the resulting credentials in Engine 2's native `auth.json`; authentication in
the helper never writes account files.

The upstream revision is pinned in [Cargo.toml](Cargo.toml) and
[engines.lock.json](../../engines.lock.json):
`763094e1b6a7c17450ee8399b06cda1853847ca5` (Prime Agent v0.10.0). The builder applies
Cargo source overrides for the exact patched Engine 2 checkout and checks its locked
dependency graph. Subscription flows use
`pa_ai::oauth`; Prime Inference, Agent Traces, and MCP flows use `pa_core::auth`
and `pa_core::mcp`. Provider endpoints, token exchange, PKCE, callback validation,
refresh formats, and MCP endpoint binding remain the upstream implementation's
responsibility. The helper adapts UI callbacks and Prime's account/team picker.

Saved-session forks call the same pinned native APIs: `pa_core` creates a full
fork, and `pa_daemon::session_store::SessionFile` creates the selected entry's
branch with its active labels. Both read the source without taking over a
resident worker or rewriting its file. The native engine determines the new
identity, parent session, history, and metadata.

## Build and packaging

Run `node scripts/build-prime-auth.mjs` from the repository root. The first build
requires Rust 1.98.1 (selected by `rust-toolchain.toml`) and the platform linker. It builds for
the host's Rust target from `engines.lock.json` and stages `vengeance-prime-auth`
(`vengeance-prime-auth.exe` on Windows) with its `build.json` receipt in
`resources/prime-auth/bin`. A later build reuses that helper, without a checkout or toolchain,
while its source, native engine, platform and target fingerprint and its recorded hash match.
Cargo uses the checked-in lockfile, so native schema additions, including Ultrafast session
entries, reach both the engine and helper. Build objects live in the ignored
`.cache/prime-auth/target` directory.

Packaging places the binary and `THIRD-PARTY-NOTICES.txt` in
`<resources>/prime-auth`. End users need neither Rust nor the other engine.
The build applies Engine 2's runtime dependency checks: no GNU compiler runtime DLL on Windows
(`libgcc`, `libstdc++`, `libwinpthread`); on Linux only the C runtime and no symbol newer than
GLIBC 2.35; on macOS only system libraries, a macOS 13.0 minimum and a reproducible ad-hoc
signature.

## Protocol and lifecycle

The protocol is UTF-8 JSON Lines over private child-process pipes. Each process
handles one sign-in in its default mode. Its first frame is `ready` with
protocol version `1`, the upstream revision, supported providers, and optional
mode availability. Vengeance checks this frame before sending `start`.
`--version` prints that metadata and exits without reading account files or
accessing the network.

`--system-prompt-default` prints the bundled native system prompt's static foundation as
`{ "ok": true, "protocol": 1, "revision": "...", "result": { "text": "..." } }`.
Metadata advertises `systemPromptDefault: true`. This read-only mode calls
`pa_core::prompts::system_prompt_breakdown` and selects its native static segments. It reads no
account or project files and starts no daemon, worker, provider request or kernel. User replacements,
appended instructions, model-specific layers and the session tail are excluded. Vengeance labels
this bundled foundation separately from a running session's exact native `get_system_prompt` view;
the latter also works when a custom engine is selected. Main bounds output to 1 MiB and validates
the protocol and revision before rendering it.

`start` supplies `providerId`, `cwd`, `agentDir`, and optionally the native Prime
CLI config path. `method` defaults to `oauth`; `api_key` starts the native key
validation flow for Prime Inference or Agent Traces. Replies identify a prompt
by `promptId`; `cancel` and stdin EOF stop the flow. The helper emits notices,
prompts, prompt cancellation, and one completion. Successful completion carries
the native credential to the main process only. Renderer events never contain
that credential. Provider response bodies and stderr are not forwarded into
the interface.

The main process bounds frames, validates the credential shape, expires idle
sign-ins, and stops the helper on cancellation or app shutdown. Once credential
saving starts, it completes as one atomic account-store transaction. Prime
Inference team selection follows the native distinction between choosing a
team, choosing a personal account, and keeping the selection for the same key.

## Updating the upstream dependency

The helper and bundled engine use the same qualified native source. To adopt a
new upstream base or native patch:

1. Review the upstream `pa-ai`, `pa-core`, `pa-daemon`, and `pa-types` public APIs
   used by all helper modes, including native credential and descriptor types.
2. For a new upstream base, update the root `engines.lock.json`, all git revisions in
   `resources/prime-auth/Cargo.toml`, `UPSTREAM_REVISION` in `resources/prime-auth/src/main.rs`, and
   `HELPER_REVISION` in both
   `src/main/engine/prime/auth-oauth.ts` and `src/main/engine/prime/restart-native.ts`
   and the built-in prompt consumer `src/main/engine/prime/system-prompt.ts`
   together. Search for the old revision to catch additional consumers. Export native patches
   before building. Run `node scripts/build-prime-auth.mjs --update-lockfile` to regenerate
   `Cargo.lock` with the same source overrides used by regular locked builds; review the diff.
3. Keep protocol version `1` only when all request and response shapes remain
   compatible; otherwise update both ends' version checks.
4. Rebuild and run the mock bridge, native no-network, application typecheck,
   build, and screenshot checks. Verify the packaged helper with a minimal
   system PATH so a local compiler install cannot hide a DLL or shared-library
   dependency.

Interactive provider sign-in is a separate manual verification step and must
only run when the user authorizes it. Automated tests use temporary account
directories or mocked responses and never modify the user's account files.

Follow [UPSTREAM.md](../../UPSTREAM.md) for engine/helper qualification. A matching
helper handshake proves agreement with Vengeance's expected helper revision;
it does not prove compatibility with a newly installed Prime engine.

## Saved-session mode

`--session` accepts one bounded JSON object on stdin and emits one JSON result,
without the authentication handshake. A `fork` operation supplies `path`, `cwd`,
and `sessionDir`; a `branch` operation supplies `path`, `entryId`, and `sessionDir`.
Success returns `{ "ok": true, "path": "..." }`; failure returns
`{ "ok": false, "error": "..." }`. This mode uses local native session APIs and
does not start a daemon, a model request, or a Python environment. It writes only
the new destination session. Listing and workspace discovery do not invoke it.

## Saved lineage and explicit child deletion

`--session-lineage` accepts `{ "agentDir": "...", "sessionDirs": ["..."] }` and returns
`{ "ok": true, "result": { "sessions": [], "excludedPaths": [], "warning": null } }`.
Each session row contains its canonical `path`, optional ledger `name`, and `lineage` with native
child ID, depth, runtime kind and parent identity. The ledger supplies topology and tombstones;
bounded native headers supply durable IDs. No worker, daemon, provider request, kernel or legacy
registry migration starts. Missing parents remain explicit orphan lineage. Unsupported paths,
non-session sidecars and unadmitted artifact files are omitted. Capacity failures produce a warning
while the app keeps independently listed root sessions visible.

The metadata advertises `sessionLineage: true` and `sessionDelete: true`. `--session-delete` is an
explicit mutation mode used only for a user's Delete action. It validates the child header and unique
ledger edge while holding mandatory native leases for both parent and child. Live ownership refuses
the operation. A recovery transcript is synced before the source is removed, then the helper writes
the native deletion/usage record. Main moves the recovery file to the Recycle Bin (the Trash on
macOS and Linux); a failed native write or recycle action reports its retained recovery path.
Resident parents use their native `delete_rlm_subagent` command, including its running-child refusal.

Patch `0016` adds the native read-only constructor and a single resolved-edge replay snapshot.
The ordinary native constructor keeps its migration behavior. Requalify moved/orphan paths,
retained tombstoned files, duplicate session IDs, active-owner refusals and failed deletion recovery
when changing this boundary.

## Resource mode

`--resources` accepts one bounded JSON object with `operation`, `cwd`, and
`agentDir`. `list` resolves all native resource groups, including disabled
resources, and configured package metadata; missing packages are skipped without
installation. `toggle` also supplies a resource `item` and `enabled`, verifies
its native identity, and calls the native resource configuration writer. Success
returns `{ "ok": true, "result": { "groups": [], "packages": [] } }`; failure
returns a safe error.
Resource resolution runs outside the asynchronous runtime because the native
configuration APIs use blocking locks.

## Trace mode

`--traces` accepts one bounded JSON object with `action`, `cwd`, `agentDir`, and
optional `sessionFile` and `sessionDir`. It calls the native trace APIs for
`status`, `on`, `off`, `preview`, `preview-content`, `upload`, `upload-current`,
or `upload-all`.
Success returns `{ "ok": true, "result": {} }`; failure returns a safe error.
Bulk uploads may emit progress frames before completion. Action metadata omits
stored account credentials and remote error bodies. Native preview content
travels through the private main-process pipe; Vengeance returns a structural
preview by default and requires an explicit content view to reveal bounded
content with recognized credentials redacted. Upload actions send the native
session data and run only when requested through the application.

## Restart configuration mode

`--restart-config` accepts one bounded JSON object identifying the native agent,
session file, daemon socket, update roster, account directory, and backup
directory. `inspect` validates the durable worker and proposed `configPatch`.
`workers` validates every descriptor in the daemon's worker directory and returns
the worker process IDs. `capture` saves the prepared roster, worker descriptors,
and recovery journals before the application stops those workers. `patch`
updates the selected session's typed native create commands. `rollback`
validates the captured worker identities and restores the descriptors, journals,
and roster. The application coordinates these operations with the native
daemon's update preparation and owns cleanup after a successful restart or
rollback.

The `--version` metadata advertises `restartConfig: true` and
`restartCapture: true`. Before preparing a native update or writing restart
state, the application requires both flags, protocol version `1`, and the pinned
upstream revision. A helper without capture support is rejected before the
daemon is suspended. The capability field extends the metadata without changing
the authentication protocol.

Success returns `{ "ok": true, "result": {} }`; failure returns a safe error.
Result metadata contains identity and file locations, never the create command
or credentials. The source session file is not rewritten by this mode.
