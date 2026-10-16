# Vengeance 0.2.5 engine qualification

> Historical qualification and installation report for 0.2.5. The account/sign-in observations,
> running processes, branch state, artifact hashes and cleanup record below apply to that checkpoint;
> they are not a statement of current account or installation status. See [current guides](../README.md),
> [engines.lock.json](../engines.lock.json) and [the later engine audit](ENGINE-AUDIT-2026-10-14.md).

Native qualification and the available application matrix passed on Windows x64. Vengeance 0.2.5 is
installed and its files match the qualified package. Both installed engines completed real provider
turns, and the normal profile preserves all saved histories, preferences and open-session references.
Engine 2's saved ChatGPT sign-in still cannot resolve a usable credential; its live ChatGPT turn
requires user reconnection before that provider path can be called verified.

The upstream bases remain pi v1.2.0 (`06a466935536f8c9bcacb2d5efc0fc021be1bdff`) and Prime
v0.10.0 (`763094e1b6a7c17450ee8399b06cda1853847ca5`). Both distributions advance to
`+vengeance.3`; the application advances to 0.2.5. The exported, ordered patches and
`engines.lock.json` reconstruct both builds. pi's extension-facing SDK version remains `1.2.0`.

## Native defects and resulting behavior

Engine (pi):

- External editor commands accept quoted executable and argument paths, including spaces on Windows.
- Resource filter patterns use portable separators.
- Native self-update and automatic version checks stay disabled for the Vengeance distribution,
  independently of environment variables. Native package and model operations remain available.
- The pinned catalog's missing Claude Haiku 5.5 entry receives qualified reasoning, context, pricing
  and inherited vision limits. Sonnet 5.5's cache-read price is corrected. Custom model overrides
  retain their native precedence. This temporary catalog patch must be requalified on each new base.

Engine 2 (Prime):

- Windows session windows use volume/file identity and native change stamps. Same-size replacement
  and restored modification times cannot validate stale content. Certification denies concurrent
  writes; busy writers and unsupported filesystems use the full reader. Durable appends retry a
  sharing violation for up to two seconds, and failure to refresh a cache cannot undo an append.
- File leases and cron store keys resolve existing ancestors before appending missing path components,
  keeping their identity stable when directories are created.
- A named-pipe listener keeps its accepting instance through cancellation. It creates the next
  instance only after a connection reaches the awaited one.
- Blocking pipe clients use synchronous handles and bounded reads, so resume/continue code can call
  them from an asynchronous runtime. This removes nested-runtime panics while retaining read deadlines,
  EOF handling and busy-pipe retries. Timed reads poll availability at five-millisecond intervals.
- Daemon command reads retain partially received input when an event or response interrupts a select
  branch. A fragmented command now receives its own response ID instead of an invalid-JSON response
  without an ID. This was the cause of the reproduced command stalls during input-pause checks.
- Native package operations find Windows `npm.cmd`, including a configured bare `npm` command;
  explicit custom programs and arguments retain their meaning.
- Edit failures distinguish directories, missing paths and permission errors using the expected
  model-facing error names. Directory access probes support Windows directory handles.
- Rotated-log notices use stable Windows file identities, detecting unread crash records without
  inventing duplicate restart notices.

The fixtures also qualify native Windows paths, shell quoting, command-line limits, Git commit
timezone/line endings, SDK file URLs and unprivileged filesystem aliases. Directory junctions exercise
the mutation queues on Windows; tests requiring privileged file symlinks remain capability-gated.
Workers and live kernels use normal teardown. The abort fixture waits for an actual provider request,
so an early admission abort cannot be mistaken for cancellation during a provider wait. POSIX SIGTERM
tests run on Unix; Windows RPC EOF, abort, replacement and transport checks still run.

## What changed the settings file

In Engine's (pi) settings, only `lastChangelogVersion` changed from `1.1.0` to `1.2.0`, and the final newline was removed.
Reverting exactly those two differences in memory reproduced the entire original SHA-256. No user
preference changed in that file.

The native interactive CLI writes this acknowledgement through
`getChangelogForDisplay()` → `SettingsManager.setLastChangelogVersion(VERSION)`. Its settings writer
uses JSON serialization without a final newline. A fresh temporary profile reproduced both changes
using the actual bundled interactive CLI, with no prompt submitted. Vengeance's RPC startup does not
enter that interactive helper. The historical process or launcher responsible cannot be identified
from the retained evidence; the writer and exact changes are established. The correct metadata was
not reset.

Engine 2 has a separate, later change at 19:03:19 Berlin time (17:03:19 UTC). Its default model
changed from `gpt-6-astra` to `gpt-6.1-sol`, thinking changed from `xhigh` to `max`, the default
service tier changed from null to `priority` (Fast), and the new model was prepended to
`recentModels`. Reverting exactly these four changes in memory reproduces the entire hash recorded
by the 0.2.4 installation snapshot. No other Engine 2 setting changed.

The saved native session `01a135d7-8832-7746-97b9-e4d5b2b05059.jsonl` records the matching model,
thinking and service-tier changes at 17:03:15.747, 17:03:17.688 and 17:03:19.511 UTC. The last
event precedes the settings file's timestamp by four milliseconds. Native daemon model/thinking
handlers in `model_switch.rs` and the speed handler in `setting_switches.rs` call
`SettingsManager.set_default_model_and_provider`, `set_default_thinking_level` and
`set_default_service_tier`. The model setter also records the recent model. Thus live session
controls become native defaults for subsequent sessions; these writers come from upstream and are
not changed by this patch series. The retained evidence identifies the commands and writer but
cannot identify the person or client that submitted them. The current selections were not reset.

## Native verification

```text
node scripts/checks/pi-workspace.mjs check
Entry point graphs are within budget.
packages/coding-agent/install-lock is up to date.
✓ isolated native Engine checks passed
✓ both real account configurations remained unchanged

node scripts/checks/pi-workspace.mjs
✓ isolated native Engine checks passed
✓ both real account configurations remained unchanged

node scripts/checks/pi-changelog.mjs  [terminal required]
✓ native interactive startup acknowledges 1.2.0 and removes the final newline
✓ the unrelated preference remains unchanged; no prompt was submitted
✓ real Engine configuration remained unchanged

node scripts/checks/prime-workspace.mjs --with-kernel
4,449 passed; 0 failed; 14 ignored across 212 test targets
Finished `dev` profile [unoptimized + debuginfo] target(s) in 10.59s
✓ isolated native workspace checks passed
✓ both real account configurations remained unchanged
```

pi's full run uses upstream `./test.sh`, including both filesystem-retention passes. It passes agent,
AI, chord, codemode, coding-agent, durable, environment, web UI, mom, eval and terminal suites.
The coding-agent suite passes 2,648 tests; durable passes 1,220 tests in each retention mode.
The AI suite passes 1,342 tests and explicitly skips 865 credential-dependent live API tests.
External SSH fixtures and platform/privilege-specific cases are also reported as skipped.

Engine 2 passes 1,091 core, 906 daemon, 1,370 terminal, 140 shared-type, 261 CLI, 326 AI, 48 model,
61 telemetry and 15 agent unit tests, plus its available Windows integration suites. Meaningful
regressions include 44 ACP, 23 print-runtime, 20 RPC, three Windows transport and three Windows session
window checks. The temporary kernel runs all three prewarm tests and the packaged-session RLM test.
The normally ignored fresh packaged-sidecar bootstrap test was run separately and passed.
Its remaining ignored tests are native benchmark/race harnesses; Unix-only binaries contain no tests
on this platform. No live provider coverage is inferred from these counts.

Cargo formatting and clippy with `--workspace --all-targets -- -D warnings` pass. The vendored
crossterm dependency still emits five upstream cfg/dead-code warnings; no warning suppression was added.

## Application and package verification

`npm run typecheck`, `npm run checks`, `npm run build` and `npm run shots` pass. The screenshot run
produces 315 captures. Visual inspection covers both engines' controls, settings, traces, edit diffs,
light/dark themes, narrow layouts, restart history and extension status.

The build's final output and the formatter command for every touched application script/configuration
are recorded below. The formatter executable comes from the local npm cache.

```text
npm run build
✓ built in 23.50s

node C:/Users/dev/AppData/Local/npm-cache/_npx/e15b1a32801f1a37/node_modules/prettier/bin/prettier.cjs --check \
  docs/NATIVE-QUALIFICATION-0.2.5.md \
  'scripts/checks/{pi-changelog,pi-workspace,prime-workspace}.mjs' \
  'scripts/qa/{auth/model-parity-real,ext/resources,performance/session-listing,performance/workspaces,sessions/tree,shell/packaged}.qa.mjs' \
  package.json package-lock.json engines.lock.json
Checking formatting...
All matched files use Prettier code style!

npm run checks
✓ all checks passed
```

Eight rebuilt native contract checks pass: bundled distribution identity/update guards, native
authentication, OAuth adaptation, native restart capture, resident identity, trace handling,
the native protocol and the public adapter. Their outer guard verifies both real account
configurations. The package loads both native engines and the helper with only the Windows system
PATH. Copied OpenAI Codex compatibility 0.0.23 and Black 0.1.0 extensions load through the upstream
1.2.0 SDK, retain saved history through restart and complete a subsequent turn.

The model-parity QA fixture waits for the background account-offerings lookup before taking its
baseline. It compares every model surface with the resulting native list, retaining all names,
reasoning, vision, context and grouping assertions. SDK/theme/session-listing fixtures resolve the
shipped package rather than a user CLI installation. Packaged shell checks require the bundled
distribution, Electron runtime, upstream SDK and all six bridge commands, including response speed.

The complete application matrix contains 86 suites. After correcting the fixtures and rerunning the
failed cases, 85 executed suites pass with no remaining failure. The paid multi-provider fixture
remains an explicit opt-in skip. Packaged engine and extension checks were run separately with the
exact release executable, covering the package-only suite skipped in the initial matrix.

Workspace QA opens the switcher independently of a chat pane, waits for restored/selected chats where
required, drives coalescing through public session-change events and creates the native history file
that the reopen preflight reads. This avoids counting a second startup discovery caller as a parallel
renderer scan. Tree actions use the locator's retrying click/scroll behavior during label refresh.
The tool suite's process-guard failure came from the independently running packaged QA instance
exiting; its serial rerun passes. The unused `readFile` import in the session-listing fixture was
removed. These fixture changes do not change application behavior.

The installer exits with code 0. Installed version is 0.2.5; `app.asar`, both payloads and the native
helper match the release artifacts. A tiny real-provider turn through installed Engine succeeds with
no session file. Installed Engine 2 also completes a real DeepSeek V4 Flash turn with reply `ok`,
using a temporary workspace and no saved session. Neither engine's preferences changed during these
attempts. The native APIs represent an absent session path differently: Engine omits it and Engine 2
returns an empty string. Both checks require an absent path rather than assuming it must equal null.

Engine 2's default ChatGPT turn settles with `No API key for provider: openai-codex`. Its saved
provider is detected, but native credential resolution produces no usable key. The upstream OAuth
resolver converts refresh failure into an absent key while retaining the stored sign-in, so a
configured provider row alone does not prove the credential is usable. This patch series does not
change that resolver. The retained diagnostic cannot establish the underlying refresh failure or
attribute it to the upgrade. User reconnection is pending; the authentication dialog is not automated.
Engine's native OAuth refresh updated credential metadata normally, without exposing credentials.

```text
Installed Engine live check
✓ installed pi 1.2.0+vengeance.3: real provider replied ok; no session saved

Installed Engine 2 live check (DeepSeek V4 Flash)
✓ installed Engine 2 completed a real provider turn; no session saved
✓ both real account preferences remained unchanged

Final normal-profile preservation check
✓ 188 saved histories retain their complete original contents
✓ 3 account configurations and 4 saved open-session references are preserved
✓ application preferences remain unchanged
```

## Artifact identities

All hashes below are SHA-256. Packaging verifies the ordered patch inputs and every payload file
before and after copying the engines.

| Artifact                  | Hash                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| Engine payload            | `b0ab9eb1341f53d1795e9315fcd1b80dae5fb4e2a58ef753834744eab805dad3` |
| Engine 2 payload          | `881cef1ab78da046c725a3445fc81a1d1e2cffcce2ffc3e76cb595f3ddb70e5e` |
| Engine 2 executable       | `203b2f8c7e07cdc9f67199f65694be8f9f97f87daebcd8967d6cc789d2864c49` |
| Native helper             | `3f3cdb98e10e306fc61293e76e3b64cc4fa18f6a4d2b069d804cbd3ca6e975dd` |
| Vengeance 0.2.5 installer | `c361d92dd53af4f351a2ae15689a184eeb0a6c3a059b58c27c63fb3533c5d088` |

The helper build fingerprint is
`34449f04c61538b2adb247b4d4389e1eb50fe8e1ee65691362cee1ced2d3cfe2`. It links the same patched
native source as Engine 2 and advertises the pinned upstream revision and all required capabilities.

## Retained evidence

Local logs live under `.cache/native-qualification-*`; safe result summaries live under
`.shots/qa/native-qualification-0.2.5`. The settings report records the original and current hashes
without storing credentials. Before installation, `.shots/qa/install-0.2.5` records hashes for 188
saved histories, configuration hashes, credential-file metadata only, and a copy of application state
with four saved open sessions.

Red/green evidence covers fragmented daemon commands, blocking transport inside a runtime, directory
and missing-parent edits, default npm launching, append certification and live-kernel teardown.
Installed payloads and the helper match the recorded identities. The normal profile starts Engine 2's
daemon and worker from the new `881cef1a…` cache. Its editable edit/goal kernel links migrate to that
cache through native runtime bootstrap. All 188 histories retain their complete pre-install prefix:
187 are byte-identical and one has only appended native session state. Four open-session references,
application preferences and all three existing settings/models files are preserved. Safe result
summaries include the separate live-provider outcome and the final preservation check. Live ChatGPT
verification remains pending the sign-in result.

## Cleanup and repository state

The native changes and QA fixture repairs were committed as `eb03fd4` and fast-forwarded into
`main`. The qualification report is committed separately. The repository retains one checkout and
only `main`; no remote push was performed.

Eight obsolete generated source checkouts were recycled across qualification. The two freshly
reconstructed source trees remain available for native checks. The old 0.2.4 installer/blockmap,
older packaged QA build, native debug build outputs and temporary target directories were recycled.
The idle older Engine 2 daemon accepted a graceful shutdown before its `7095ca8d…` runtime cache was
recycled. The normal profile's current daemon and worker continue from `881cef1a…`. The pinned official
Engine 2 baseline and current release artifacts remain available for comparison and reconstruction.
Cleanup receipts and test logs are retained as evidence.
