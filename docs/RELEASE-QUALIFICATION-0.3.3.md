# Vengeance 0.3.3 qualification checkpoint

19 October 2026. Local Windows qualification passes. Final five-platform release qualification is
**pending**. This record supplements the historical
[PR #15 qualification](ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md) and
[navigation comparison](PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md); it does not replace their scope,
failed attempts or known limits. Ignored logs and generated artifacts below identify the local run,
not published release assets.

## Source and review identity

| Boundary                       | Commit                                     |
| ------------------------------ | ------------------------------------------ |
| Release comparison base, 0.3.2 | `8b2319880580893356d7cc7d2fbc721c08936bf9` |
| Production macOS launch fix    | `1807866a050a080ab7296007a999cf6600ad098d` |
| Version preparation, 0.3.3     | `6384530044bd4e550c4de02739c75b19dc69f9ee` |
| Current CI and QA candidate    | `e3cbf5d362837f0dacf83d8ac9184f4776025eba` |

The production fix selects Electron 44.7.0's signed macOS background helper for Electron-as-Node
work and the login-shell probe. Missing or invalid helper paths fail closed. The main app retains
normal Dock presence. Windows, Linux and explicit custom system Node selection retain their existing
behavior; the Dock fix adds no native engine patches.

The coordinating task records final source review **CLEAR** for `e3cbf5d` against `8b23198`, and a
separate QA source review **CLEAR**. These are source reviews, not platform runtime passes.
[CodeQL run 39217927625](https://github.com/LuciferMornens/vengeance/actions/runs/39217927625)
passed. At this checkpoint,
[CI 39217933806](https://github.com/LuciferMornens/vengeance/actions/runs/39217933806) and
[Release dry run 39217933713](https://github.com/LuciferMornens/vengeance/actions/runs/39217933713)
are still running for `e3cbf5d`; final results and receipts have not been incorporated here.

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

| Platform / release runner                           | Core nine suites       | Dock observer  | Official 0.3.2 upgrade               | Release benchmark / package receipts     |
| --------------------------------------------------- | ---------------------- | -------------- | ------------------------------------ | ---------------------------------------- |
| `win32-x64` / `windows-2025`                        | Local pass; CI pending | Not applicable | Prior PR Windows transition evidence | Pending; separate local benchmark passes |
| `darwin-arm64` / `macos-15`                         | Pending                | Pending        | Pending                              | Pending                                  |
| `darwin-x64` / `macos-15-intel`                     | Pending                | Pending        | Pending                              | Pending                                  |
| `linux-x64` / `ubuntu-24.04`, 22.04 container       | Pending                | Not applicable | Pending                              | Pending                                  |
| `linux-arm64` / `ubuntu-24.04-arm`, 22.04 container | Pending                | Not applicable | Pending                              | Pending                                  |

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
