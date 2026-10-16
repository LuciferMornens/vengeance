# Vengeance 0.2.2 engine qualification

> Historical qualification for 0.2.2. Versions, hashes, results and local paths below describe that
> checkpoint. Engine 2's OpenAI speed limitation was fixed in
> [0.2.4](ENGINE2-SPEED-0.2.4.md). See [current guides](../README.md) and
> [engines.lock.json](../engines.lock.json) for the maintained build.

Qualified on Windows x64, 13 October 2026. Both engines are built from pinned upstream source,
with Vengeance patches, and included in the Windows installer. Engine upgrades ship with app
releases. The reconstruction and future upgrade procedure is in [UPSTREAM.md](../UPSTREAM.md).

## Artifact identities

| Component     | Upstream base                                             | Vengeance build      |
| ------------- | --------------------------------------------------------- | -------------------- |
| Engine        | pi v1.2.0, `06a466935536f8c9bcacb2d5efc0fc021be1bdff`     | `1.2.0+vengeance.1`  |
| Engine 2      | Prime v0.10.0, `763094e1b6a7c17450ee8399b06cda1853847ca5` | `0.10.0+vengeance.1` |
| Native helper | Same Prime stable revision                                | Protocol 1           |

Upstream release references: [pi v1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0)
and [Prime v0.10.0](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.10.0).
Prime's helper and local patches were deliberately rebased from the prior development revision
`fa20be8e487b1889c2395ea33906149aef983ca0` to the selected stable base.

| Artifact                            | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.2.exe` | `d811843ac2dfccb4a9014d268c12cb342f33f6b6f898e26017a29d27b24cd0f9` |
| Prime executable                    | `b0616a1a35ab1ac426cc8d9df8c4ac99b0dfbdddf5bf2a3216606ad536c7592d` |
| Native helper executable            | `46d532cbc84550d11b08ca2d1670b996da16c5bb4f0682c9398e479e1e9d0f8f` |
| Complete pi payload inventory       | `e8222fd476c43575dcbe29ca1439e8fada6f90708cfe25c9eab1f58d8bd03f11` |
| Complete Prime payload inventory    | `328616808d04840a48a5586c91866a5e78d56d62a5ecd8b4f85ff7bd05e915c8` |

Inventory hashes cover sorted paths and file hashes, rather than a single archive. The shipped
`resources/engines/manifest.json` also records each patch hash, source revision and build fingerprint.
Packaging verified all 14,947 pi files and all 61 Prime files both before and after copying them.
The 19 patched Prime source files matched the reviewed source checkout byte for byte.

## Behavior changes

- Both engines default to their included builds. pi runs using Electron's Node runtime and loads
  its matching SDK. Explicit custom locations remain available. Automatic global/PATH engine
  discovery is removed; a damaged bundle gives an actionable repair error.
- Prime runs from a complete cache indexed by its payload hash under the app's user-data folder.
  Old caches remain available to resident daemons across installer replacement. Failed cache copies
  clean up their staging directory; damaged completed caches fail explicitly.
- Native engine self-update, channel switching, reinstall and rollback operations are replaced by
  Vengeance app releases. Native and app-level guards prevent replacing customized engines with an
  upstream binary. Onboarding, Engine settings and the Updates sheet explain this ownership.
- Native package updates, model catalogs, custom providers, account/configuration storage,
  extensions, resources and session operations remain engine-owned. Prime stable's package update
  arguments are used by both the Updates sheet and Settings.
- pi 1.2 MCP resource support is normalized from its boolean capability. Older custom engines'
  numeric resource counts are also accepted. The GUI renders resource support correctly.
- Restarting after a lost Prime daemon handles the native recovery handoff: a worker can hold the
  saved file's lease before the supervisor accepts attachment. Only that lease-conflict/unknown-ID
  combination gets a 30-second retry window. Other errors and closing requests do not retry.
  Recovery never bypasses the native lease or creates a duplicate worker.
- Removed the unused managed Prime installer, package-directory enumerator, pi release-check SDK
  binding, engine-install UI, channel-store action and unreachable engine-update branches.
  No diagnostic transport instrumentation remains in production or in the recovery QA runner.
- QA loads the bundled SDK, isolates Python bytecode caches from candidate packages, covers the
  app-owned update policy, and repeats daemon-loss recovery. Native patch reconstruction rejects
  edited source checkouts and altered release payloads instead of overwriting them silently.

The source patches keep native compaction cancellation and shell-context/replacement fixes, add
distribution identity/update guards, and retain the Windows release-packer correction. The app
continues to use each native agent loop and tool implementation.

## Validation evidence

Commands ran from the repository with isolated account, session and workspace directories.
Real engine processes used local fake provider endpoints; no production credentials or paid model
requests were needed. Native source tests were scoped to the relevant regressions.

```text
npm run typecheck
> tsc --noEmit -p tsconfig.web.json
[exit 0]

npm run build
pi: verified 1.2.0+vengeance.1
prime: verified 0.10.0+vengeance.1
✓ built in 24.71s

npm run checks
✓ all checks passed

QA_TMP_ROOT=D:/Vengeance-QA-temp node scripts/checks/bundled-engines.mjs
✓ pi 1.2.0+vengeance.1: system PATH, native self-update refusal, config intact
✓ prime 0.10.0+vengeance.1: system PATH, native self-update refusal, config intact
✓ bundled native engine checks passed

QA_TMP_ROOT=D:/Vengeance-QA-temp node scripts/checks/prime-source.mjs
✓ native Prime source regressions and clippy passed

QA_TMP_ROOT=D:/Vengeance-QA-temp node scripts/checks/prime-resident-identity.mjs
PASS recovery: lease conflicts wait for adoption; other errors and closing do not retry.

QA_TMP_ROOT=D:/Vengeance-QA-temp \
VENGEANCE_PRIME_EXECUTABLE=D:/Coding/vengeance/.engine-staging/bundled/prime/prime-agent.exe \
PYTHONDONTWRITEBYTECODE=1 node scripts/checks/prime-resident-identity.mjs --native
PASS native metadata: sibling restart refreshes get, list, and ready worker PIDs.

QA_DAEMON_LOSS_CHECKS=10 QA_TMP_ROOT=D:/Vengeance-QA-temp \
QA_REPORT_DIR=D:/Coding/vengeance/.shots/qa/recovery-fixed \
node scripts/qa/engines/session-recovery.qa.mjs
✓ native historical session recovery passed
report.json: passed=true, checks=7, daemonLoss.length=10

node scripts/dist.mjs
• building block map  blockMapFile=release\Vengeance-Setup-0.2.2.exe.blockmap
[exit 0]

node scripts/dist-qa.mjs --dir
pi: verified 1.2.0+vengeance.1 (14947 files)
prime: verified 0.10.0+vengeance.1 (61 files)
[exit 0]
```

The pi source check passed upstream formatting/type/lock/entry-graph checks. Prime passed Cargo fmt,
18 user-shell tests, eight replacement-gate tests, two HTTP compaction-abort tests, and clippy for
`pa-cli` and `pa-daemon` with `-D warnings`. The helper's OAuth adapter suite passed 17 checks and
its native local-server suite passed four checks.

| Public-boundary coverage      | Result                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both engines together         | Native integration suite passed: concurrent streams, Python output, queues, abort, settings/accounts/models, resources, history, exports, branches, restart and relaunch |
| Prime native controls         | Goals, autonomy, refinement, subagents, schedules, side questions, factory configuration and trace previews passed                                                       |
| Exact candidate identity      | Four model/reasoning/restart checks passed; worker executable hashes matched the reviewed candidate                                                                      |
| Official-to-custom transition | Three checks passed; native identity and saved history survived, then the customized engine answered                                                                     |
| Settings and providers        | Settings suites passed, including 71 documented settings across 73 rows; provider lists, key precedence and subscription controls passed                                 |
| Extensions and MCP            | Extension flags/tools/UI, local packages, updates, resources and real MCP tool/resource calls passed                                                                     |
| Session lifecycle             | Concurrency, history, export, restart, launch environment, storage, tree and workspace focus suites passed                                                               |
| Stop and response speed       | Native compaction cancellation, shell queue, restart notices, side questions, speed and subscription routing suites passed                                               |
| App-owned updates             | Six checks passed, including IPC refusals, both native package-update entrypoints, offline state and active-session isolation                                            |
| Onboarding                    | Included-engine and missing-bundle/custom-location flows passed                                                                                                          |

The final compatibility run reported:

```text
node scripts/qa/run.mjs --only ext/mcp.qa.mjs --only shell/onboarding.qa.mjs \
  --only engines/updates.qa.mjs --only engines/session-recovery.qa.mjs
All 4 suite(s) passed

node scripts/qa/run.mjs --only engines/candidate-controls.qa.mjs \
  --only engines/candidate-transition.qa.mjs
All 2 suite(s) passed

node scripts/qa/engines/integration.qa.mjs
✓ engines-integration passed
```

Candidate suites used the executable and SHA-256 above in `QA_PRIME_EXECUTABLE` and
`QA_PRIME_SHA256`. Detailed local screenshots/results are under `.shots/qa/final-compat`,
`.shots/qa/final-candidate`, `.shots/qa/recovery-fixed` and `.shots/qa/bundled-0.2.2`.

The final packaged and visual gates passed after rebuilding with the recovery fix:

```text
QA_PACKAGED_EXE=D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe \
QA_TMP_ROOT=D:/Vengeance-QA-temp \
QA_REPORT_DIR=D:/Coding/vengeance/.shots/qa/final-packaged \
node scripts/qa/engines/packaged.qa.mjs
✓ packaged native helper loads with only the Windows system PATH
✓ packaged Engine streams and loads its external bridge
✓ packaged Engine2 streams through its native resident API
✓ public Engine2 sign-in loads the packaged helper and cancels before a key
✓ packaged-engines passed

npm run shots
Screenshots in D:\Coding\vengeance\.shots
[exit 0]
```

The entire packaged app ran with `PATH` restricted to Windows System32. Both engine descriptors
reported bundled versions, pi used Electron's Node, and Prime used its versioned app cache.
The packaged helper hash matched the staged helper. Reviewed PNGs include both packaged engine
transcripts, Engine settings and Updates, onboarding/repair, connected MCP resources, Prime's Bone
settings, compact trace controls and the narrow Bone workspace switcher.

Formatting used Prettier on every changed supported file, plus Rust formatting on native source:

```powershell
$files = @(git diff HEAD --name-only --diff-filter=ACMRTUXB; git ls-files --others --exclude-standard) |
  Where-Object { $_ -match '\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml)$' -and (Test-Path -LiteralPath $_) }
npx.cmd prettier --check $files
# All matched files use Prettier code style!

cargo fmt --manifest-path resources/prime-auth/Cargo.toml --check
# exit 0

git diff --cached --check -- . ':(exclude)patches/**/*.patch'
# exit 0
```

Unified diff context lines intentionally contain upstream indentation and blank-line prefixes;
patch files are excluded from Git's plain-text whitespace check. Their reconstructed source passed
the native formatters. The final source review found no debug instrumentation or new oversized files.

## Findings addressed during qualification

The MCP suite exposed pi 1.2's resource-count contract change. Package-maintenance QA exposed
unsupported Prime stable CLI flags. Recovery stress captured a native lease conflict followed by
an early failed attach, then successful roster adoption; the deterministic protocol regression and
ten native restart cycles qualify the fix. An installer hash check also detected generated Python
bytecode in the candidate package: the generated files were moved out and QA cache writes isolated.

Old onboarding and SDK-version test assumptions were updated for included engines. A tooltip-only
subscription test timeout during concurrent GUI testing passed in isolation; final GUI checks run
serially. Failed runs were retained locally for diagnosis rather than counted as successful coverage.

## Coverage limits

This qualification tests real engine behavior and app integration with controlled provider replies;
it is not a benchmark of model intelligence. Live provider OAuth completion and paid provider calls
were not exercised. Native package installation and language tools keep their own prerequisites,
such as npm, Git, Bash or Python environment provisioning.

Existing upstream limits recorded in UPSTREAM.md still apply: Prime OpenAI/ChatGPT Fast mode remains
unavailable until native request propagation is fixed and qualified; pi's own compaction-summary
request uses standard speed. These limits were not introduced by bundling.

The installer was built locally. The release feed was not published and the user's installed app
was not replaced. Upstream updates still require the documented review/rebase/qualification process.
