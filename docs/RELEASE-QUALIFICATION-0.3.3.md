# Vengeance 0.3.3 qualification checkpoint

19 October 2026. Final five-platform release qualification is **pending** at
`404d24dfde231a4f5937205a6f5f93461d4d091d`. Ordinary CI passes and several native gates pass;
remaining failures and unrun gates below prevent an overall qualification claim. Historical
[PR #15 qualification](ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md) and
[navigation comparisons](PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md) retain their own source scope.
Ignored local evidence identifies tested artifacts, not published release assets.

## Source, review and analysis identity

| Boundary                                                 | Commit                                     |
| -------------------------------------------------------- | ------------------------------------------ |
| Release comparison base, 0.3.2                           | `8b2319880580893356d7cc7d2fbc721c08936bf9` |
| Production macOS launch fix                              | `1807866a050a080ab7296007a999cf6600ad098d` |
| Version preparation                                      | `6384530044bd4e550c4de02739c75b19dc69f9ee` |
| First failed release candidate                           | `e3cbf5d362837f0dacf83d8ac9184f4776025eba` |
| Isolation/readiness repair candidate                     | `835f034aec60fa38b787f347256ecefa7d506797` |
| Linux Trash dependency fix                               | `b6025224d6c52ebf1d8c613ac7f3c67dcdee6e1e` |
| Current CI/QA candidate and bounded native diagnostics   | `404d24dfde231a4f5937205a6f5f93461d4d091d` |
| Committed macOS identity / artifact-path repair          | `2a94d7bebbcaf01728b4aac336fa4e29c774dd6f` |
| Committed benchmark seeding / restart diagnostics repair | `e3c6352cedc64175584cb2849cc78d77eb603a1c` |
| Reviewed Linux resident-liveness repair                  | `5843076`                                  |

The macOS production fix uses Electron 44.7.0's signed background helper for Electron-as-Node work
and login-shell probing, failing closed when unavailable. The main app retains normal Dock presence.
Windows/Linux and custom system Node selection retain their behavior; this fix adds no engine patch.
The coordinator records source review CLEAR at `e3cbf5d` against `8b23198` and separate QA review
CLEAR. Those reviews apply to their identified source, not later runtime outcomes.

Current [CI 39229025642](https://github.com/LuciferMornens/vengeance/actions/runs/39229025642) passes
all eight jobs, including macOS shots. [CodeQL 39229020899](https://github.com/LuciferMornens/vengeance/actions/runs/39229020899)
passes all three analyses. The coordinator's current-PR open-code-alert query returned `[]`;
this records that query's scope. Earlier `835f034` [CI 39222761658](https://github.com/LuciferMornens/vengeance/actions/runs/39222761658)
and [CodeQL 39222757745](https://github.com/LuciferMornens/vengeance/actions/runs/39222757745) also
completed successfully; successful analyses alone do not establish absence of vulnerabilities.

Existing moderate [Dependabot #2](https://github.com/LuciferMornens/vengeance/security/dependabot/2)
for `sprintf-js` is a development/build-transitive dependency already present before this PR.
At this checkpoint no patched version is offered and no shipped dependency path was found in the
reviewed graph. This is a scoped dependency finding, not a general security guarantee.

## Current release attempt: `404d24d`

[Release 39229025591](https://github.com/LuciferMornens/vengeance/actions/runs/39229025591) remains
incomplete. Windows, Linux x64/arm64 and macOS arm64 pass all nine packaged core suites.
macOS arm64 also passes the Dock observer and both official `.10` → `.11` upgrade suites.
Its built-app benchmark then fails a process-ownership check based on mutable `ps comm` titles;
the `libproc` identity repair is committed in `2a94d7b` but not runtime-qualified.
No current macOS benchmark pass is recorded.

Both Linux architectures pass candidate-transition, then resident-upgrade times out; diagnosis is
pending. A Linux resident-liveness semantic repair is committed in `5843076`; its relationship to the exact
`404d24d` timeout remains a hypothesis pending new native evidence. Linux upgrade artifact files were
omitted by absolute multiline path translation in the container upload step. The relative-report-path
repair is committed in `2a94d7b`, without gate/assertion changes or a qualifying rerun.
Windows reaches benchmark seed-history handoff, then
refuses with “Wait for the current session operation to finish before switching engines”; a harness
readiness repair is committed in `e3c6352`, awaiting rerun. Intel macOS repeats the integration failure.
Its retained worker logs show runtime → `mcp` 2.3.0 → `pyjwt[crypto]` 2.15.1 → `cryptography` 50.0.2;
the cryptography source build invokes maturin, then rustup cannot select Cargo because isolated HOME
has no default toolchain. Evidence is `mac-x64/_temp/engine-qualification/run-hcq1fY/2-engines-integration/engines-shots/native-diagnostics/`
under `.cache/ci-39229025591`. `runtime.json` records eight untruncated logs, no capture errors and
only seed packages installed. A current cryptography wheel packaging repair for Intel is being
implemented without a dependency downgrade; no new native identity or qualified build is recorded yet.

The Linux liveness source change has independent review CLEAR. Local typecheck, build (20.39 s), checks
and QA packaging pass in `.cache/0.3.3-liveness-{typecheck,build,checks,package}.log`; those local gates
do not establish the affected Linux native restart outcome.

The root visually reviewed the macOS arm64 desktop PNG: one Vengeance icon, no generic exec icons.
`.cache/ci-39229025591/review-mac-dock/receipt.json` records CLEAR within that observed scope:
249 OS frames, seven checkpoints, foreground-executable witness policy 0, helper policy 1,
zero unexpected foreground applications, and the same Prime PID 76638 after detach/reconnect.
A desktop image covers one checkpoint; policy frames cover the recorded observation interval.

Current static visual receipts under `.cache/ci-39229025642/review-{linux,win}/review-receipt.json`
are CLEAR with coverage of all 383 captures per platform, using direct/contact-sheet inspection and
verified pixel-identical carry-forward. This does not mean every image was separately read at full
size. Current macOS review is CLEAR for all 363 provided captures in `review-mac/review-receipt.json`;
20 absent display variants remain outside that artifact's coverage. Native review is CLEAR for 95
macOS PNGs (79 core / 16 upgrades) in `.cache/ci-39229025591/review-mac-native/review-receipt.json`,
and all 158 Linux core PNGs (79 per architecture) in `review-linux-native/coverage-receipt.json` under
that same release root. A cropped macOS renderer capture has a complete native companion; this
review does not use the crop alone as full-window evidence.

| Platform / native release runner                    | Current core suites                                    | Dock                   | Official 0.3.2 upgrade               | Current benchmark / final receipts           |
| --------------------------------------------------- | ------------------------------------------------------ | ---------------------- | ------------------------------------ | -------------------------------------------- |
| `win32-x64` / `windows-2025`                        | Nine pass                                              | Not applicable         | Prior PR Windows transition evidence | Seed handoff readiness fails; repair pending |
| `darwin-arm64` / `macos-15`                         | Nine pass                                              | Pass; desktop reviewed | Both suites pass                     | Process-identity check fails; repair pending |
| `darwin-x64` / `macos-15-intel`                     | Integration fails: cryptography source-build toolchain | Pending                | Pending                              | Wheel packaging repair not yet qualified     |
| `linux-x64` / `ubuntu-24.04`, 22.04 container       | Nine pass                                              | Not applicable         | Transition passes; resident timeout  | Pending; upgrade artifact upload incomplete  |
| `linux-arm64` / `ubuntu-24.04-arm`, 22.04 container | Nine pass                                              | Not applicable         | Transition passes; resident timeout  | Pending; upgrade artifact upload incomplete  |

Receipts under `.cache/ci-39229025591` identify macOS core `run-7sQLNl`, upgrade `run-rHhSec` and Linux
arm64 core `run-pJlkxk`; other job outcomes come from the coordinator. Every platform builds natively;
Linux uses pinned Ubuntu 22.04/glibc 2.35. One host's results do not qualify another.

## Earlier failures and focused repairs

At `e3cbf5d`, [release 39217933713](https://github.com/LuciferMornens/vengeance/actions/runs/39217933713)
failed all five jobs/skipped installs despite green CI: macOS sockets needed 106 bytes versus a
104-byte limit, and Linux/Windows lacked uv. `835f034` fixes isolated temp paths, byte budgets and
activation/disposal waits, and installs uv 0.13.1 using setup-uv v10.3.0 at
`1c37ad07a6a961277cf70c0d37d6f313000f5884`, caching disabled.

At `835f034`, [release 39222762172](https://github.com/LuciferMornens/vengeance/actions/runs/39222762172)
again failed all five jobs/skipped installs. Linux lacked `gio`; `b602522` adds Debian `libglib2.0-bin`,
RPM `/usr/bin/gio`, pacman `glib2` and CI prerequisites. macOS arm64 passed nine core suites, then
called Playwright `process()` after close; the repair caches the child. Windows passed six suites
before queue deletion timed out. A controlled 1024×736 witness reproduces an arriving preview moving
the button during a press; waiting for all three previews preserves neighbors and deletes once.
This proves fixture susceptibility, not the archived CI sequence.
Logs: `.cache/0.3.3-bash-queue-{pointer-witness,fixed-compact,ci-repair}.log`.

Intel's `835f034` packaged suite passed, then pip exited 1 after 16.543 s and a subagent timed out.
Cleanup lost stderr; `404d24d` retains the logs establishing the cryptography failure above. Focused
Windows integration passed with 26 PNGs reviewed and no owned processes remaining
(`.cache/0.3.3-integration-ci-repair.log`), without qualifying an entire release attempt.

## Completed identified local Windows run

Windows x64, Electron 44.7.0; isolated native accounts, sessions and kernel environments use
`QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts`, outside the repository and real account homes.
Commands are shown in Git Bash syntax from the managed checkout:

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

| Gate                | Result / evidence                                                                  |
| ------------------- | ---------------------------------------------------------------------------------- |
| Typecheck           | Both projects pass; coordinator's completed `npm run typecheck` record             |
| Build               | Pass, renderer 20.00 s; `.cache/0.3.3-build.log`                                   |
| Contract checks     | Pass; `.cache/0.3.3-checks.log`                                                    |
| Mock screenshots    | 20 scenarios / 383 PNG records; `.cache/0.3.3-shots.log`                           |
| QA package          | pi 14,932 files / Prime 61 files verified; `.cache/0.3.3-package.log`              |
| Packaged matrix     | Nine suites pass, no timeout/unrun suite; `.cache/0.3.3-platform.log`              |
| Built-app benchmark | Six strict samples pass, zero scroll failures; `.cache/0.3.3-first-navigation.log` |

Receipt `.shots/qa/0.3.3-platform-win32-x64/run-kChaQx/qualification.json` covers 07:35:03–07:43:50 UTC,
with a 900,000 ms per-suite deadline. The suites are packaged, integration, model-isolation,
system-prompts, restart-safety, stop-compaction, bash-queue, session-recovery and resident-close.
Restart safety includes 12 native checks; Stop/compaction includes 10. Per-suite packaged-target
receipts identify Vengeance QA 0.3.3, actual resources and isolated accounts. Root viewed all 11 mock
prompt states and representative layouts; independent review covered all 79 native and six benchmark
PNGs. This does not claim review of all 383 local mock captures. The transcript-recovery null/trim
log is its asserted malformed-frame fixture, not normal rendering.

Benchmark `.shots/perf/first-navigation/release-0.3.3-win-local.json` records three fresh processes
per backend, `qualified: true`, no scroll-failure recording, zero scroll failures and no warmup,
forced focus or trace diagnostics. Its six PNGs/CPU profiles are adjacent. Histories have 60 turns;
the endpoint is the marker visibly inside transcript/window without the opening layer.

| Visible endpoint median, ms      | Engine | Engine 2 |
| -------------------------------- | -----: | -------: |
| Shell                            |  323.7 |    312.6 |
| First conversation               |  494.4 |    860.1 |
| Second conversation, first visit |  342.5 |    571.9 |
| Cached return                    |   71.6 |     49.9 |

This uses built output, not `QA_PACKAGED_EXE`, and remains separate from the historical comparison:
Engine opens 825/544 → 491/340 ms; Engine 2 877/487 → 901/549 ms; blocking 128 → 4 and 122 → 19 ms.
Cached returns added 20–25 ms; a roughly 210 ms startup frame gap remained. No cross-platform speed
improvement or new causal estimate is inferred. Later QA/workflow paths require their own results.

## Artifact identities and retrieval evidence

Local QA executable/native hashes come from the packaged receipt and helper probe; built hashes come
from the benchmark. These are not final shipping-installer hashes.

| Local Windows artifact           | SHA-256                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| QA executable                    | `20eaf634c6abc222ec2edbc564ebe9adf2e7785065b79b8681eedb59177d1758`                                                                      |
| Built main                       | `b870c3570c89e6bf1486930843f1e6871cf494b24430f2af4a6047f7abdbab07`                                                                      |
| Built renderer index             | `facedcab9f2b1f9f9065b08cbcfe42d05097c31f8c6480798d6f61eff8ad1564`                                                                      |
| pi `.2` payload / CLI entry      | `97f796c58c176d6f78f1bbb45564c26225d53826bcb34b479865900002d18a39` / `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774` |
| Prime `.11` payload / executable | `64f695dd72aa9ddad9a41b3e70344522512c50654c89a2d78a6164ff14f654b2` / `d5b58cad3bb96f2c7075626cbf4215125ad8a118281b10a2717904d0ebdbdad1` |
| Native helper                    | `1de7bea53c7f128ba5e7801e5570ac3b34e996475b1069a13f8a4b471df6774f`                                                                      |

pi `1.3.0+vengeance.2` is based on `71023aec1546d6d677a65669c5665c0927ce0dd0`; Prime
`0.10.0+vengeance.11` on `763094e1b6a7c17450ee8399b06cda1853847ca5`. Local input fingerprints are
`57ade0946aad71efecac33ae268ada9c3f0e6de9e206cfdd246d097432d8f841` (pi) and
`ddc7335e5f42fad308e6f5465e2497cfa07bc3d8686f816150bcaedd9e37135f` (Prime).

Authenticated downloads are retained in `.cache/ci-<run>`; verified hashes below identify ZIP archives,
not contained native/package files. A dash means no metadata ID is recorded here.

| Run / ZIP                 | Artifact ID   | SHA-256                                                            |
| ------------------------- | ------------- | ------------------------------------------------------------------ |
| `39217933713/mac-arm64`   | `12171013241` | `135fa0af1357924d5ad3fd3ba318d403ede2027f749d6b6cdeebb4f4a3fdd4e8` |
| `39217933713/linux-arm64` | `12171875481` | `9aebf4dd38792d3170b341f2d848f0e84dda9c4380abdd10cb30825b56e6abf1` |
| `39217933713/win-x64`     | `12171523112` | `34a7d4b049fda6ca071821744c73c9713edb6554a5ed98470dae8e656486e7b9` |
| `39222762172/linux-x64`   | —             | `9dbd8dd6232355887154e9cba9a6084ef06e6de3633f29128f7500a1876aeda8` |
| `39222762172/mac-arm64`   | —             | `fcc361a2c5fd7c8594b68a1656ecd8d888c39b1e380b7b39d1e372081619a8be` |
| `39222762172/mac-x64`     | `12174372611` | `cff71ffb0af857edd33763519dfac8647d29d818d3a795a7b26401c745d70620` |
| `39222762172/win-x64`     | —             | `9f88b09940961a47eae02c96cd43bcd9d0fb11464def2fd409224dda2a62dc1d` |
| `39229025591/linux-arm64` | `12177502495` | `ee835291cd3708348be1f32bb6dc84320ae8a63a55bd149907b94424c56ebfb7` |
| `39229025591/linux-x64`   | `12178332895` | `c9f119e30c67ec8543eebc51f8a746fde88921a1ad8f338447837bf9fb57d907` |
| `39229025591/mac-arm64`   | `12177522297` | `638aaadebad5507d1f5087b767050f618656426111fece9077754b2fe17e568f` |
| `39229025591/mac-x64`     | `12177119720` | `7abd2fa7633ece8840dc0f86400c796f5ad52a49a57810f61cf45e45f5002efa` |
| `39229025591/win-x64`     | `12178442609` | `4a608dc4587a36a1cbe8b0d3365b9cefdd20c92e5e6ccc2be730a1dd4e9ab8ce` |

## Remaining gates and limits

- Keep final-head packaged identities, desktop evidence, baseline/upgrade reports, benchmark results
  and `provenance-<platform>` shipping-file hashes. Signature/zip/dmg, glibc and package-install gates
  also must complete. The current artifact-path repair must retain the actual Linux upgrade logs.
- The official baseline loader pins public 0.3.2 checksums, complete native inventories and macOS
  signatures. Upgrade coverage proves the identified `.10`/`.11` pair. pi remains `.2`; its older
  1.2 → 1.3 fixture is historical, not this release's gate.
- Core QA excludes paid-provider inference, completed external OAuth, installer/window-manager and
  AppImage-mount lifecycle coverage. The arm64 Dock receipt is platform/scenario-specific. Physical
  Mac/compositor coverage is not inferred from CI. macOS remains ad-hoc signed, without notarization.
- Process-cold samples do not flush filesystem caches or establish broad statistics. Historical
  startup-frame and synthetic scroll-follow geometry limits remain in the performance report.
- By user request, stopped diagnostic folders `vengeance-qa-run-rbuzFd` and
  `vengeance-qa-engines-D7ECf0` remain under `D:/Coding/vengeance-qa-engine-prompts`. They are not active
  processes or passing evidence; this follow-up does not delete them. Real user accounts remain untouched.
