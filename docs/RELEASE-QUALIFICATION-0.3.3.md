# Vengeance 0.3.3 qualification checkpoint

19 October 2026. The identified local Windows run and ordinary CI pass. The `835f034` release dry run
has partial native passes and unresolved gates; final five-platform qualification is **pending**. This record supplements the historical
[PR #15 qualification](ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md) and
[navigation comparison](PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md); it does not replace their scope,
failed attempts or known limits. Ignored logs and generated artifacts below identify the local run,
not published release assets.

## Source and review identity

| Boundary                             | Commit                                     |
| ------------------------------------ | ------------------------------------------ |
| Release comparison base, 0.3.2       | `8b2319880580893356d7cc7d2fbc721c08936bf9` |
| Production macOS launch fix          | `1807866a050a080ab7296007a999cf6600ad098d` |
| Version preparation, 0.3.3           | `6384530044bd4e550c4de02739c75b19dc69f9ee` |
| Earlier failed release candidate     | `e3cbf5d362837f0dacf83d8ac9184f4776025eba` |
| Last CI and QA candidate             | `835f034aec60fa38b787f347256ecefa7d506797` |
| Committed Linux Trash dependency fix | `b6025224d6c52ebf1d8c613ac7f3c67dcdee6e1e` |

The production fix selects Electron 44.7.0's signed macOS background helper for Electron-as-Node
work and the login-shell probe. Missing or invalid helper paths fail closed. The main app retains
normal Dock presence. Windows, Linux and explicit custom system Node selection retain their existing
behavior; the Dock fix adds no native engine patches.

The coordinating task records final source review **CLEAR** for `e3cbf5d` against `8b23198`, and a
separate QA source review **CLEAR**. These are source reviews, not platform runtime passes.
[CodeQL run 39217927625](https://github.com/LuciferMornens/vengeance/actions/runs/39217927625)
passed. These clear reviews apply to `e3cbf5d`; the repaired harness still needs a clean runtime rerun.
Earlier [CI 39217933806](https://github.com/LuciferMornens/vengeance/actions/runs/39217933806) passed;
[release dry run 39217933713](https://github.com/LuciferMornens/vengeance/actions/runs/39217933713)
failed all five build jobs and skipped downstream installation jobs. Current outcomes follow.

## `835f034` CI and partial release results

[CI 39222761658](https://github.com/LuciferMornens/vengeance/actions/runs/39222761658) passes every job;
[CodeQL 39222757745](https://github.com/LuciferMornens/vengeance/actions/runs/39222757745) passes with
no alerts. Windows/Linux produced 383 mock captures each; macOS produced 363 because responsive
guards skip layouts beyond its 1024×684 runner work area. Reviews of 237 selected Linux and 237
selected Windows captures are CLEAR, recorded in `.cache/ci-39222761658/review-{linux,win}/review-receipt.json`.
macOS review is also CLEAR for 217 selected mock captures and all 79 native core captures, recorded in
`.cache/ci-39222761658/review-mac/review-receipt.json` and
`.cache/ci-39222762172/review-mac-native/review-receipt.json`. Each mock review leaves 146 captures
outside its selected scope. These static reviews do not qualify the Dock witness or runtime focus.

[Release 39222762172](https://github.com/LuciferMornens/vengeance/actions/runs/39222762172) finishes with
all five build jobs failed and installation jobs skipped.
Both Linux architectures pass core suites 1–3, then system-prompts fails moving an instruction file
to Trash because `gio` is missing. The reviewed dependency repair adds Debian `libglib2.0-bin`, RPM
`/usr/bin/gio`, pacman `glib2`, and the CI prerequisite. It is committed as `b602522`; clean runtime qualification is pending.
macOS arm64 passes all nine core suites. Its Dock observer then fails in cleanup by calling
Playwright `process()` after close; the reviewed repair caches the child first. The partial
production-shell checkpoint observes regular main policy 0 and helper policy 1, but the complete
Dock witness has not passed. Windows passes suites 1–6, then bash-queue times out on atomic deletion;
focused local queue tests pass. A controlled 1024×736 pointer witness reproduces a missed deletion
when a newly arriving preview moves the button during the press; waiting for all three previews
produces one correct deletion and preserves both neighboring native deliveries. This establishes
fixture susceptibility, not the exact archived CI event sequence. The readiness repair is independently
CLEAR; evidence is `.cache/0.3.3-bash-queue-{pointer-witness,fixed-compact,ci-repair}.log`.
macOS Intel passes
suite 1, then integration fails two steps: native `uv pip install` exits 1 after 16.543 s, followed by
a subagent-request timeout cascade. uv is present; the exact bootstrap failure cause is unknown.
Detailed native uv stderr was lost during fixture cleanup. Bounded owned worker-log preservation
before cleanup is being added so the next native attempt can obtain the actual failure reason.
That attempt proceeds with the three reviewed Linux dependency, cached-child and queue-readiness
repairs. None has a clean full release rerun yet.

Verified downloaded archives are under `.cache/ci-39222762172`; their extracted qualification reports
identify `run-1k7v5S` (Linux x64), `run-Z0KbXQ` (macOS arm64), `run-0VMe4g` (Windows) and `run-M16h6x`
(macOS Intel, artifact ID `12174372611`).

| ZIP             | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `linux-x64.zip` | `9dbd8dd6232355887154e9cba9a6084ef06e6de3633f29128f7500a1876aeda8` |
| `mac-arm64.zip` | `fcc361a2c5fd7c8594b68a1656ecd8d888c39b1e380b7b39d1e372081619a8be` |
| `mac-x64.zip`   | `cff71ffb0af857edd33763519dfac8647d29d818d3a795a7b26401c745d70620` |
| `win-x64.zip`   | `9f88b09940961a47eae02c96cd43bcd9d0fb11464def2fd409224dda2a62dc1d` |

## Failed `e3cbf5d` release dry run

Authenticated artifacts from run 39217933713 are retained under `.cache/ci-39217933713`.
The downloaded ZIPs were hashed and match their public artifact metadata; these identify archives,
not individual packaged binaries. Extracted reports are under each platform directory's
`_temp/engine-qualification` (Linux: `__w/_temp/engine-qualification`).

| Artifact          | Metadata ID   | Verified ZIP SHA-256                                               |
| ----------------- | ------------- | ------------------------------------------------------------------ |
| `mac-arm64.zip`   | `12171013241` | `135fa0af1357924d5ad3fd3ba318d403ede2027f749d6b6cdeebb4f4a3fdd4e8` |
| `linux-arm64.zip` | `12171875481` | `9aebf4dd38792d3170b341f2d848f0e84dda9c4380abdd10cb30825b56e6abf1` |
| `win-x64.zip`     | `12171523112` | `34a7d4b049fda6ca071821744c73c9713edb6554a5ed98470dae8e656486e7b9` |

Both macOS architectures timed out at Prime readiness: nested worker sockets required 106 bytes,
beyond Darwin's 104-byte capacity. Linux/Windows integration failed first kernel setup without uv,
with later Python/child cascades; root inspected their failure PNGs. `835f034` shortens isolated
POSIX `TMPDIR`, validates socket byte budgets, repairs activation/disposal waits, and installs uv
0.13.1 through setup-uv v10.3.0 at `1c37ad07a6a961277cf70c0d37d6f313000f5884` without caching.
The direct benchmark uses the repaired temp-path contract; no final release benchmark pass is recorded.

### Focused repaired integration pass

`.cache/0.3.3-integration-ci-repair.log` records a passing focused Windows integration run after the
harness repairs, including Python output, subagent controls, activation/disposal and detach/relaunch.
The agent reviewed all 26 PNGs with no blocking issue and reported no owned processes remaining.
This focused pass does not qualify the full repaired release matrix or direct benchmark.

## Completed local Windows checks

Host: Windows x64, Electron 44.7.0. Native accounts, sessions and kernel fixtures use
`QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts`, outside the repository and real account homes.
The installed user app and its account directories are not writable fixtures.

Commands used, shown in Git Bash syntax from the managed checkout; output is retained in the logs
listed below:

```sh
npm run typecheck
npm run build
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' npm run checks
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' npm run shots
node scripts/dist-qa.mjs --dir
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' \
QA_PACKAGED_EXE='C:/Users/mitte/.codex/worktrees/engine-prompts-performance/vengeance/release/qa/win-unpacked/VengeanceQA.exe' \
QA_REPORT_DIR='C:/Users/mitte/.codex/worktrees/engine-prompts-performance/vengeance/.shots/qa/0.3.3-platform-win32-x64' \
  node scripts/qa/engines/platform-qualification.mjs
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' \
  node scripts/perf/first-navigation.mjs --label release-0.3.3-win-local --runs 3
```

| Gate                   | Recorded result                                                            | Evidence                                                     |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Typecheck              | Passed, both TypeScript projects; coordinator's completed gate record      | `npm run typecheck`                                          |
| Build                  | Passed; renderer build 20.00 s; native/helper integrity accepted           | `.cache/0.3.3-build.log`                                     |
| Contract checks        | Passed, including check TypeScript and bridge/native types                 | `.cache/0.3.3-checks.log`                                    |
| Mock screenshots       | 20 scenario files, 383 successful PNG records                              | `.cache/0.3.3-shots.log`                                     |
| QA packaging           | Passed; pi 14,932 files and Prime 61 files verified before/after packaging | `.cache/0.3.3-package.log`                                   |
| Packaged native matrix | Nine suites passed, exit 0 throughout, no timeout, no unrun suite          | `.cache/0.3.3-platform.log` and qualification JSON below     |
| Built-app navigation   | Six strict samples passed, zero scroll failures                            | `.cache/0.3.3-first-navigation.log` and benchmark JSON below |

The mock transcript-recovery scenario intentionally logs the asserted malformed-frame null/trim
error while demonstrating recovery; it is not a normal-rendering failure. Mock PNGs do not establish
native Dock or operating-system window behavior.
The local runs identify tested application bytes by the hashes below. Later QA/workflow changes at
`e3cbf5d`, including the upgrade group, require their own CI results; source review does not make
those new runtime paths a local pass.

### Packaged matrix

Receipt: `.shots/qa/0.3.3-platform-win32-x64/run-kChaQx/qualification.json`.
Run: 07:35:03–07:43:50 UTC, 19 October. The configured per-suite deadline was 900,000 ms.

All nine recorded suites pass: `engines/packaged`, `engines/integration`, `engines/model-isolation`,
`settings/system-prompts`, `engines/restart-safety`, `engines/stop-compaction`, `engines/bash-queue`,
`engines/session-recovery` and `engines/resident-close` (all `.qa.mjs`). Restart safety includes 12
native checks; Stop/compaction includes 10. Per-suite `packaged-target.json` receipts identify
Vengeance QA 0.3.3, the actual packaged executable/resources and separate temporary native accounts.
Native inventories were verified again at completion. Each numbered suite directory retains its
receipt, result, logs and captures.

Visual review recorded by the coordinating task: an independent reviewer inspected **all 79 native
PNG captures** and **all six benchmark PNGs**, with no blocking visual issue. The root task inspected
all **11 system-prompt mock states**, plus representative mock states. This does not claim visual
review of all 383 mock PNGs.

### Current-candidate navigation

Report: `.shots/perf/first-navigation/release-0.3.3-win-local.json`, with six adjacent PNGs and six
CPU profiles. It records `qualified: true`, `recordScrollFailures: false`, zero scroll failures and
three fresh processes per backend. Warmup, forced focus and frame/trace diagnostics were disabled.
Histories have 60 turns; the endpoint is the final marker visibly inside the transcript and window,
without an inert/opening layer. Source/native identities and scroll/syntax evidence are retained.

| Visible endpoint median, ms      | Engine | Engine 2 |
| -------------------------------- | -----: | -------: |
| Launch to shell                  |  323.7 |    312.6 |
| First conversation               |  494.4 |    860.1 |
| Second conversation, first visit |  342.5 |    571.9 |
| Cached return                    |   71.6 |     49.9 |

This benchmark uses the built app, not `QA_PACKAGED_EXE`. It establishes current-candidate checks,
not an isolated causal estimate or a new before/after comparison. Historical Windows results remain
separate: Engine first-open 825 → 491 ms; first-visit renderer blocking 128 → 4 ms and Engine 2
122 → 19 ms. Engine 2 wall times were mixed (877/487 → 901/549 ms), cached returns cost another
20–25 ms, and an approximately 210 ms startup frame gap remained. No macOS/Linux speed improvement
is inferred from either Windows series.

## Local artifact identities

SHA-256 values come from the packaged qualification receipt, benchmark report and packaged-helper
probe in `0.3.3-platform.log`. The QA executable is not a production installer; final shipping package
hashes and per-platform release receipts remain pending.

| Artifact               | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Windows QA executable  | `20eaf634c6abc222ec2edbc564ebe9adf2e7785065b79b8681eedb59177d1758` |
| Built main bundle      | `b870c3570c89e6bf1486930843f1e6871cf494b24430f2af4a6047f7abdbab07` |
| Built renderer index   | `facedcab9f2b1f9f9065b08cbcfe42d05097c31f8c6480798d6f61eff8ad1564` |
| pi `.2` payload        | `97f796c58c176d6f78f1bbb45564c26225d53826bcb34b479865900002d18a39` |
| pi CLI entry           | `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774` |
| Prime `.11` payload    | `64f695dd72aa9ddad9a41b3e70344522512c50654c89a2d78a6164ff14f654b2` |
| Prime executable       | `d5b58cad3bb96f2c7075626cbf4215125ad8a118281b10a2717904d0ebdbdad1` |
| Packaged native helper | `1de7bea53c7f128ba5e7801e5570ac3b34e996475b1069a13f8a4b471df6774f` |

Engine `1.3.0+vengeance.2` remains based on `71023aec1546d6d677a65669c5665c0927ce0dd0`;
Engine 2 `0.10.0+vengeance.11` remains based on `763094e1b6a7c17450ee8399b06cda1853847ca5`.
Their Windows input fingerprints are respectively
`57ade0946aad71efecac33ae268ada9c3f0e6de9e206cfdd246d097432d8f841` and
`ddc7335e5f42fad308e6f5465e2497cfa07bc3d8686f816150bcaedd9e37135f`.

## Pending platform qualification

Each platform builds natively. Linux release builds use the pinned Ubuntu 22.04 container for glibc
2.35. Ordinary CI tests Windows x64, macOS arm64 and Linux x64; the release workflow covers all five
rows. A Windows result does not qualify another host.

| Platform / release runner                           | Core nine suites                                                    | Dock observer                                | Official 0.3.2 upgrade               | Release benchmark / package receipts     |
| --------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| `win32-x64` / `windows-2025`                        | Local nine pass; current release 1–6 pass, 7 fails                  | Not applicable                               | Prior PR Windows transition evidence | Pending; separate local benchmark passes |
| `darwin-arm64` / `macos-15`                         | All nine pass                                                       | Cleanup fails; partial shell checkpoint only | Pending                              | Pending                                  |
| `darwin-x64` / `macos-15-intel`                     | 1 passes; 2 fails Python bootstrap and subagent step; cause unknown | Pending                                      | Pending                              | Pending                                  |
| `linux-x64` / `ubuntu-24.04`, 22.04 container       | 1–3 pass, 4 fails; dependency repair pending rerun                  | Not applicable                               | Pending                              | Pending                                  |
| `linux-arm64` / `ubuntu-24.04-arm`, 22.04 container | 1–3 pass, 4 fails; dependency repair pending rerun                  | Not applicable                               | Pending                              | Pending                                  |

The release sequence is core packaged QA; macOS activation-policy/desktop observation; official
same-platform upgrade QA on both macOS and Linux architectures; then the built-app benchmark.
The baseline loader verifies pinned public 0.3.2 `SHA256SUMS`, archive hashes, complete native
inventories and macOS signatures. Its JSON selects the `.10` baseline and packaged `.11` candidate
for candidate-transition and resident-upgrade suites. pi stays `.2` in both releases; its older
1.2 → 1.3 fixture is historical, not this release's gate.

Before release, fill the table from actual final-head outcomes and inspect the uploaded PNGs. Retain
`engine-qualification-<platform>` reports (core, Dock, baseline, upgrade and benchmark), native/helper
identities and `provenance-<platform>` receipts with shipping-file hashes. Signature/dmg/zip checks,
glibc checks and package-install gates must also complete. Artifact ZIP digests alone are not native
payload or contained-package hashes.

## Limits and retained fixtures

- The core nine-suite local receipt excludes executable transitions and mixed-version resident
  upgrades. Its other explicit limits are paid-provider inference, completed external OAuth,
  installer/desktop-window-manager behavior, Dock behavior and AppImage-mount lifecycle. Separate
  pending suites qualify only their identified scenarios and baseline/candidate pair.
- macOS observation requires actual OS activation policies, the normal-mode shell probe, desktop
  PNGs and a red/green witness. A renderer screenshot or an `LSUIElement` file alone is insufficient.
- Three process-cold samples per backend are not a broad statistical claim; OS filesystem caches
  are not flushed. The unresolved startup frame gap and synthetic scroll-follow geometry ambiguity
  remain in the historical performance report.
- Live sign-in and paid-provider behavior were not exercised. macOS signing remains ad-hoc, without
  Developer ID or notarization; physical Mac and desktop-compositor coverage is not inferred from CI.
- At the user's request, the two older, stopped fixture folders remain under
  `D:/Coding/vengeance-qa-engine-prompts`: `vengeance-qa-run-rbuzFd` and
  `vengeance-qa-engines-D7ECf0`. They are retained diagnostic fixtures, not active QA processes or
  passing qualification evidence. This follow-up does not delete them.
