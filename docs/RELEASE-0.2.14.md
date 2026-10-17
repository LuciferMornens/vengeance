# Vengeance 0.2.14 release verification

Windows x64 qualification for the stable Engine update and Engine 2 conversation families.

## Engines and compatibility

- Engine is built from upstream stable `v1.3.0`, commit
  `71023aec1546d6d677a65669c5665c0927ce0dd0`, as `1.3.0+vengeance.1`.
- Engine 2 remains on upstream stable `v0.10.0`, commit
  `763094e1b6a7c17450ee8399b06cda1853847ca5`, as `0.10.0+vengeance.9`.
  Beta and nightly releases were audited separately. A lock-only rustls maintenance update advances
  both the native engine and helper to `0.23.46`.
- Native OAuth refresh keeps the provider flight lock through credential persistence and reload.
  Concurrent callers share the refreshed credential; network requests remain outside the account
  document lock. A paused-write regression failed against stable code and passes with the fix.
- Native patches, exact source revisions and catalog hashes are recorded in `engines.lock.json`.
  The Engine catalog patch was retired because the stable catalog supplies the required models and
  capabilities. Windows fixtures and the Abliteration provider were reconciled with the new base.
- The public SDK package reports the upstream `1.3.0` version; Vengeance build metadata carries the
  distribution suffix. Native model validation, active-tool restoration, provider behavior and
  session writing remain native engine responsibilities.
- Upstream `kimi-coding` now uses Chat Completions. Custom base URL overrides for that provider must
  include `/v1`, as described in the linked native release notes. The upstream update also restores
  active tools on resume and drops another model's thinking blocks during a model switch.

Latest stable releases were checked through the official release pages and GitHub API on 16 October
2026: [Engine](https://github.com/earendil-works/pi/releases/tag/v1.3.0) and
[Engine 2](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.10.0).

## Conversations and opening performance

- Engine 2 subagents appear beneath their parent, including nested children and resident or saved
  histories. Unresolved orphans remain accessible. Independent sessions and same-depth forks stay
  independent even when they carry ancestry metadata.
- File paths disambiguate sessions with duplicated native/header identifiers. Concurrent saved-file
  and resident opens join one attachment. Precise Stop actions target the selected session; an
  ambiguous legacy identifier is rejected before any worker is stopped.
- A fresh saved-history open recovers when an adopted daemon's cached endpoint has disappeared.
  The connection factory closes the failed transport and retries once with a fresh client, only for
  a missing or refusing endpoint from an adopted cache entry. Owned startup failures, protocol and
  permission errors remain visible. Restart barriers and quarantine still apply; no RPC is replayed.
- Ordinary depth-zero chats skip global child-topology discovery during opening, rename and Delete.
  Child and unknown-depth histories still use the native lineage ledger. One describe request reuses
  its verified identity; subsequent requests revalidate.
- Family metadata is memoized independently of streamed tokens. Sidebar search and family rendering
  are separated into feature modules. Focused scale checks cover 4,800 saved histories and 7,200
  background aliases.
- Read-only discovery uses one ledger snapshot and bounded session headers. It creates no daemon,
  worker, provider request, migration, session or cache. A partial lookup warning keeps healthy roots
  and verified children accessible.
- Scoped lists observe the native default ledger as well as configured session folders. Native
  admission can keep ancestry in that ledger when saved histories use a custom folder. Root-file
  discovery and workspace filtering stay scoped; nested children remain visible and exact-path
  tombstones still exclude deleted histories. The regression failed before this lookup fix and passed
  afterward, including a same-workspace file outside the selected session folder and zero worker calls.
- Explicit child Delete uses native deletion when a parent is resident. Offline deletion verifies
  the exact child edge, acquires native leases, creates a durable recovery copy and writes the native
  tombstone. Running-child refusal, recovery errors and partial discovery errors remain visible.
  A deleted original path cannot silently reappear. A restored history can be imported as a new
  session. Close tab and Stop remain separate actions.
- Trusted lineage persists across a child reopen and is discarded when the native session changes.
  Extended Windows and UNC paths use the same identity normalization in both processes.

## Native session sharing and settings

- Engine sharing supports Auto, GitHub gist and Radius through its native export/upload code.
  Readiness reads configuration without contacting a service or refreshing credentials. Sharing
  rechecks the reviewed destination before upload, including after an engine switch.
- Auto selects gist when no Radius credential exists. A Radius upload error is reported without
  falling through to a different destination. The dialog describes organization visibility and
  uploaded system/tool metadata before consent.
- Saved sharing reads session bytes without adding a trailing newline or creating an authentication
  store for a gist. Uploads use an explicit temporary HTML output and clean it up afterward.
- Saved Radius metadata reconstructs the current built-in system/tool configuration with extensions
  disabled. Historical extension schemas cannot be recovered from a saved history alone.
- Sessions settings expose the native sharing destination. The advanced model editor exposes the
  native mid-conversation effort capability for the supported OpenAI Responses route. Terminal
  settings were extracted without changing their definitions.
- Native build scripts accept bounded job counts for constrained Windows machines. Test builds can
  omit debug symbols while keeping assertions. Generated caches are ignored by Git.

This release includes the conversation switching, deletion and long-history changes documented in
[0.2.13](RELEASE-0.2.13.md) and [0.2.12](RELEASE-0.2.12.md).

## Review

GPT 6.1 Sol independently reviewed the implementation and native contracts. Public implementation
commit `d6263c50e079fa908ba9e0f03e2aa71b99ab6400` was approved without actionable findings,
including the root-opening, same-request identity and scoped custom-ledger fixes. All native build inputs match
the published source byte for byte: 12 Engine inputs, 25 Engine 2 inputs and 13 additional helper
inputs. Qualification logs are kept locally in `.engine-staging/release-0.2.14/`.

Native qualification exposed the refresh race and scheduling assumptions in upstream test fixtures.
The streaming, queued goal-pause and telemetry tests now coordinate actual native events and timer
boundaries. Their count, ordering, pause and delivery assertions remain enforced. Bun's worker fixture
checks prompt cancellation before cleaning up its process; Node still must exit within one second.
The retry-broadcast fixture shuts down its native worker before dropping its test runtime, closing
the kernel pipe readers that caused the historical teardown stall. No production streaming, goal or
telemetry behavior changed in these fixture patches.

The stdin collector exposes its receive call through a private adapter for deterministic idle-window
tests. Production still calls the standard channel's `recv_timeout` with the full idle window for
each receive; collection, EOF and timeout behavior remain intact. A single-deadline mutant fails the
reset test, while all four correct-source tests pass, including real-channel EOF and idle checks.
Patch author headers use the public noreply identity, so native build fingerprints use the exact
published patch bytes.

The public checkout uses a different synthetic OpenRouter key in its mock configuration. AST review
confirmed that this literal is its only app-source difference from the qualified local checkout;
other differences in that file are formatting. Normal native-engine startup never seeds this mock
configuration. Screenshot evidence qualifies the local compiled mock fixture. Package comparisons
check the tested compiled files directly; they do not claim whole-source equivalence with the public
mock fixture.

The Engine workspace runner builds the locked standalone Env daemon before its full suite, matching
upstream CI. Windows child processes receive Git Bash utilities even when the runner starts in
PowerShell. This test prerequisite adds no daemon to the shipped SDK.

The native GUI fixture coalesces concurrent shutdown calls and clears its in-flight promise after
settlement. A later cleanup therefore checks replacement daemons started by recovery tests, using
the same account, executable, path and foreign-process guards.

The shared speed-mode fixture recognizes the native Responses `compaction_trigger` request used by
the bridge and dedicated compaction suites. Its former `context_management` predicate timed out
after compaction had completed. The correction keeps the summary-speed, checkpoint-speed and
persistence assertions and checks that the obsolete field is absent. The full fresh replay passed
in 39.6 seconds: the native checkpoint used priority speed, summary requests used standard speed,
and defaults, persistence and relaunch checks passed. The two-line test correction was independently
reviewed; it changes no application or native-engine output.

The workspace-scale fixture targets the named row in Open sessions when closing a searched history.
Its former global-first Close locator selected the earlier reopened Engine chat during the Engine 2
iteration. The handle-close and new-handle assertions exposed that wrong click. Row scoping keeps
both checks and the committed-history comparison intact; scale, frame, memory and time bounds are
unchanged.

Focused results before the full reconstructed-source rerun:

```text
Native auth manager: 16 passed; 0 failed
Native burst streaming: 3 passed; 0 failed; 1 benchmark ignored
Native queued goal pause: 1 passed; 0 failed
Native telemetry library: 61 passed; 0 failed
Native retry broadcast with isolated Python kernel: 1 passed; 0 failed (5.26 s)
Native worker lifetime: 14 passed; 0 failed
Native worker lifetime under Electron's Node 24.21.0: 14 passed; 0 failed
Standalone Env on Windows: 63 passed; 18 platform-specific skips
100,000-item formatting performance: 833 ms; original 5,000 ms bound enforced
Helper native tests: 9 passed; 0 failed
Helper Clippy: passed with warnings denied
All native test wrappers: real account configuration guards passed
```

## Complete Engine workspace

The final reconstructed Engine workspace passed upstream `./test.sh` through
`node scripts/checks/pi-workspace.mjs`, including the locked Env build prerequisite and both
filesystem-retention passes. It ran from 21:40 to 21:53 local time on 16 October, with one CPU/worker,
one Rust build job and a one-hour outer deadline. Both real-account configuration guards passed.

| Package                     | Passed | Skipped |
| --------------------------- | -----: | ------: |
| Scripts                     |     44 |       0 |
| Agent                       |     91 |       0 |
| AI                          |  1,358 |     865 |
| Chord                       |    517 |       0 |
| Codemode                    |    226 |       0 |
| Coding agent                |  2,695 |      55 |
| Durable, each of two passes |  1,212 |       9 |
| Env                         |     63 |      18 |
| Evals                       |     55 |       0 |
| MCP                         |     44 |       1 |
| Telemetry                   |     15 |       0 |

TUI passed; its reporter prints dots rather than a leaf-test count. Skips include credential-dependent
provider tests, external SSH fixtures and platform-specific cases. No live provider sign-in or paid
inference was required for this release's qualification.

```text
node scripts/checks/pi-workspace.mjs
  ✓ isolated native Engine checks passed
  ✓ both real account configurations remained unchanged

node scripts/checks/pi-workspace.mjs check
  1,491 files checked; no formatting fixes
  ✓ isolated native Engine checks passed
```

The staged Engine contains 14,956 files. Source-receipt verification and the catalog/changelog gates
passed. The SDK worker-lifetime regression also passed all 14 tests under the shipped Electron Node
24.21.0 runtime.

The final shared-lock update changed the Engine input fingerprint to
`de69eac15e3ec833af671fd7c7becc18768ba671d520b702cd59ae0ac7565218`.
The usual source builder rebuilt and staged the Engine. Its complete payload hash remains
`ca51cadbdfd3edd5ccbff9700fe6fdddd713c0aedd16d60f1b669ddb4aca4942`, byte-identical
to the payload qualified above; the native catalog gate passed again.

## Complete Engine 2 workspace

The final `.9` source passed the complete unfiltered native workspace gate, including isolated kernel
bootstrap, formatting and strict workspace/all-target Clippy. All 216 target summaries are recorded in
`prime-workspace-final9-targets.json` alongside the full log in the local release evidence directory.
The reconstructed source hash is
`a2678ef7f402ae0c2cee094d0cf717024d32bd6b453c758326527a50b5bd385f`.

| Major target | Passed | Failed | Ignored |
| ------------ | -----: | -----: | ------: |
| CLI          |    261 |      0 |       0 |
| Core         |  1,100 |      0 |       2 |
| Daemon       |    906 |      0 |       8 |
| Telemetry    |     61 |      0 |       0 |
| All targets  |  4,468 |      0 |      14 |

All 14 ignores are upstream declarations; their names and reasons are retained in the target report.
No tests were filtered out. The native retry-broadcast fixture and the original 20 ms RPC-start
assertion passed. Both real-account guards passed, and the owned native build/test processes exited.

```text
node scripts/checks/prime-workspace.mjs --with-kernel
  4,468 passed; 0 failed; 14 ignored; 0 filtered out
  clippy --workspace --all-targets -- -D warnings: passed
  ✓ isolated native workspace checks passed
  ✓ both real account configurations remained unchanged
```

## App checks completed before native packaging

Main and renderer TypeScript checks and `npm run checks` passed against the final Engine SDK.
The complete `npm run shots` rerun exited zero: 19 scenario files and 366 PNGs. Inspected screens
include sharing destinations and errors, Delete/retry, Close/Stop, subagent controls, narrow layouts,
the composer and the native Engine transition/recovery. The recovery scenario deliberately injects
a malformed transcript frame and asserts its logged renderer error and recovery flow.

```text
npm run typecheck
  typecheck:node and typecheck:web: exit 0
npm run checks
  ✓ all checks passed
npm run shots
  Screenshots in D:\Coding\vengeance\.shots
  19 scenario files; 366 PNGs; exit 0
```

Five isolated native app suites also passed: Abliteration, API keys, OAuth UI cancellation, provider
hosting and Engine upgrade/recovery. The transition suite restored native identity, model, reasoning,
messages and tool results under Engine 1.3.0, continued the conversation, and reopened an upgraded
copy under the retained Engine 1.2.0. Four transition checks passed; no real account was used.

The final native conversation-family replay passed all six sections. It covered nested descendants,
concurrent saved/resident opens, relaunch, independent roots and same-depth forks, offline discovery,
and a fresh saved-history open after the adopted daemon disappeared. That first open reached ready
with one replacement daemon and worker, kept the child's identity and prior tool output, and made
no provider request. The independent root also reopened through All workspaces without a provider
request. All replacement processes exited during fixture cleanup. The six native screenshots were
inspected; child hierarchy and restored transcript output remained visible.

All 34 functional development suites passed: five authentication/Engine-transition suites, the
native lineage/recovery replay, ten integration/isolation/upgrade/recovery suites, thirteen control
suites and five feature suites. The shared speed fixture's corrected full replay replaces its
retained failed attempt. Coverage includes model and speed isolation, image capabilities, native
streaming, Stop during compaction, five native compaction routes, Bash queues, side questions,
extension compatibility, session lifecycle, custom session folders, export/import/share and engine
selection. GUI suites ran serially against frozen app and native output in isolated profiles.

## QA appearance and package parity

QA and production contain the same 149 tested compiled app files, including all 144 renderer files.
Their ordered renderer SHA-256 is
`3de9946b0a0fb5190c58c21e4359500005243ce9b93b69806568b6148c868a30`.
Both packages also match the qualified native engine manifest and helper bytes. Their application
identities and profile locations differ so QA can run in isolation.

Automated QA disables Windows Mica, fixes display scaling and uses a temporary profile. Production
uses native scaling, available Mica and saved appearance preferences. These runtime differences
explain the different appearance observed during testing. Screenshots cannot capture Mica; package
comparison verifies that the frontend code itself matches.

Both the isolated unpacked QA package and production NSIS installer were built before merge.
The package verifier extracts each ASAR and compares compiled files against the screenshot-tested
output. Its receipts, including installer and ASAR hashes, are retained locally in
`artifact-verification-premerge.json` and `artifact-verification.json`. The production package is
rebuilt after merge and checked against that same tested output before final delivery.

The four QA-package suites and the production shell smoke test passed. Both bundled engines
streamed from the packaged app, and the packaged helper loaded on a system-only PATH with the
expected hash and protocol.

## Performance

The five performance suites ran serially with native builds, scans and cleanup idle. All passed.
The workspace-scale and Engine 2 long-history suites ran twice after the row-scoped fixture
correction, with the same results.

| Check                               | Result                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| Engine 1,000 / 3,000 / 10,000 tools | 879 / 867 / 850 ms open; 62 / 50 / 51 ms cached switch   |
| Mounted transcript segments         | 13 at every size, including 30,003 messages              |
| Retained renderer heap              | 4.3 MiB after repeated long-history cycles               |
| Session listing                     | 126 ms cold; 57–59 ms cached; 24 concurrent in 570 ms    |
| Engine 2, 3,000 native tools        | 841–915 ms cold open; 301–329 ms resident reopen         |
| Engine 2 cached workspace switch    | 31–56 ms; 17 ms maximum frame gap                        |
| 8,300 histories, 65 workspaces      | 7–75 ms search; 33 ms maximum search frame gap           |
| Workspace switch at that scale      | 916–2,545 ms across 34 switches                          |
| Fourteen workspaces visited twice   | 23–24 MiB renderer heap; one mounted row after each pass |

Open/close churn passed for both engines. Engine 2's long-history suite made zero local-provider
requests.

## Final native builds and app output

The full `npm run build` gate passed with verified native payloads and the rebuilt helper.
All 149 compiled app files match the complete screenshot-tested build byte for byte. The renderer
build completed in 22.74 seconds. Vite reports its size warning for the main renderer bundle and
large diagram and syntax-highlighting chunks.

```text
VENGEANCE_NATIVE_BUILD_JOBS=1 npm run build:engines
  pi: verified 1.3.0+vengeance.1 (14,956 files)
  prime: staged 0.10.0+vengeance.9 (61 files)
VENGEANCE_NATIVE_BUILD_JOBS=1 npm run build:auth
  Finished `release` profile [optimized] target(s) in 5m 12s
  Staged resources\prime-auth\bin\vengeance-prime-auth.exe
VENGEANCE_NATIVE_BUILD_JOBS=1 npm run build
  ✓ built in 22.74s
  exit 0
```

The Engine 2 executable SHA-256 is
`3d9af7fcee92d429c4ba003ec31a5e47bbe880e8c19b9cddd924c3a8640cb006`.
The helper SHA-256 is `f0a6a7ea577660676ff4ab8ea84906c745ff56af1ab4316adf244d886cc2d2ca`;
its exact source/build-input fingerprint is
`8cfa5688f6f6b83860ebcb5bf7aaaba5d6ddf62687af86f86e0c02aa686d99b4`.

## Generated-cache cleanup

The reviewed cleanup allowlist covers 22 generated targets: superseded source reconstructions and
authoring directories, the native debug/test cache, and the 0.2.13 installer and blockmap. Authoring
changes are archived and checked against their live source before removal. Exact-path containment,
protected paths, active processes and filesystem links are checked before deletion; links themselves
are removed without traversing their destination. Cleanup runs after final merge, rebuild and package
verification. Its local receipt records the actual removed bytes and disk-space change.

Current source reconstructions, release build caches, bundled engines, 0.2.13 native compatibility
baselines, screenshots, qualification logs and current production/QA packages are protected. Cleanup
does not target user accounts, histories, installed-app runtime caches or the global Recycle Bin.
