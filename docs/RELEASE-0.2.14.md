# Vengeance 0.2.14 release verification

Windows x64 qualification for the stable Engine update and Engine 2 conversation families.

## Engines and compatibility

- Engine is built from upstream stable `v1.3.0`, commit
  `71023aec1546d6d677a65669c5665c0927ce0dd0`, as `1.3.0+vengeance.1`.
- Engine 2 remains on upstream stable `v0.10.0`, commit
  `763094e1b6a7c17450ee8399b06cda1853847ca5`, as `0.10.0+vengeance.8`.
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
- Ordinary depth-zero chats skip global child-topology discovery during opening, rename and Delete.
  Child and unknown-depth histories still use the native lineage ledger. One describe request reuses
  its verified identity; subsequent requests revalidate.
- Family metadata is memoized independently of streamed tokens. Sidebar search and family rendering
  are separated into feature modules. Focused scale checks cover 4,800 saved histories and 7,200
  background aliases.
- Read-only discovery uses one ledger snapshot and bounded session headers. It creates no daemon,
  worker, provider request, migration, session or cache. A partial lookup warning keeps healthy roots
  and verified children accessible.
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

GPT 6.1 Sol independently reviewed the implementation and native contracts. The reviewed code
tree `af96fd67e3f5ab5e21a521fd8c489da50068774c` was approved without actionable findings, including
the root-opening and same-request identity optimizations. Qualification logs are kept locally in
`.engine-staging/release-0.2.14/`.

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

The Engine workspace runner builds the locked standalone Env daemon before its full suite, matching
upstream CI. Windows child processes receive Git Bash utilities even when the runner starts in
PowerShell. This test prerequisite adds no daemon to the shipped SDK.

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
