# Vengeance 0.3.3 qualification checkpoint

19 October 2026. Final five-platform release qualification is **pending**. Product candidate
`dd82ee3` uses Engine `1.3.0+vengeance.2` and Engine 2 `0.10.0+vengeance.12`; benchmark repair
`bf004ff` passes locally. Local Windows gates below pass, but release run `39237513104` fails all
five build jobs. The combined native-verifier and upgrade-fixture repairs are committed and reviewed;
their native rerun still needs qualification.
Ignored local evidence identifies tested artifacts, not published release assets.

## Source and review identity

| Boundary                                        | Commit                                     |
| ----------------------------------------------- | ------------------------------------------ |
| Release comparison base, 0.3.2                  | `8b2319880580893356d7cc7d2fbc721c08936bf9` |
| Production macOS launch fix                     | `1807866a050a080ab7296007a999cf6600ad098d` |
| Version preparation                             | `6384530044bd4e550c4de02739c75b19dc69f9ee` |
| Linux resident-liveness repair                  | `5843076`                                  |
| Intel .12 wheel implementation                  | `f89b12aee5936b18d9fc711d2062a0cb98834878` |
| Intel kernel / immutable-baseline qualification | `c306d04`                                  |
| Product / remote qualification candidate        | `dd82ee33b65320062fb43a8e6923ed968471630a` |
| Explicit benchmark seed identity repair         | `bf004ffd9282c0d61e946c43d9683e84bac9c252` |
| Mach-O load classification / regression repair  | `23dff5cb1bbb3547a0825d9f4bbf3289896ad10e` |
| Bounded baseline ownership / writable fixtures  | `e8d06fa725bd66bf79a538404cd78175bf7b4c5f` |

The coordinator records final product source review CLEAR at `dd82ee3` by GPT-6.1 Sol / xhigh and
separate narrow review CLEAR for `bf004ff`. The verifier and baseline repairs also have independent
GPT-6.1 Sol / xhigh review CLEAR. Full contract checks pass after these repairs in
`.cache/0.3.3-ci-boundaries-checks.log`. Reviews and portable checks do not substitute for native gates.
[CI 39237513125](https://github.com/LuciferMornens/vengeance/actions/runs/39237513125) has seven jobs
passing, with macOS shots still running at this checkpoint.
[CodeQL 39237508760](https://github.com/LuciferMornens/vengeance/actions/runs/39237508760) passes all
three analyses. The coordinator's open-PR code-alert query returns `[]`; successful analyses and
that scoped query do not establish absence of vulnerabilities.

Existing moderate [Dependabot #2](https://github.com/LuciferMornens/vengeance/security/dependabot/2)
for `sprintf-js` is a development/build-transitive dependency present before this PR. No patched
version is offered and no shipped dependency path was found in the reviewed graph. This is a scoped
finding, not a general security guarantee.

## Engine 2 .12 implementation and portable checks

Prime retains stable `v0.10.0` at `763094e1b6a7c17450ee8399b06cda1853847ca5` with 23 ordered patches.
Patch `0023` and its builder package cryptography `50.0.2` for Intel macOS, static OpenSSL `4.0.3`,
pinned CPython `3.11.17`, build dependencies and source SHA-256 locks. Current security fixes are
retained; users need uv/network for first setup, without a Rust, C or OpenSSL toolchain. Other
platforms retain native dependency resolution.

The engine verifies the manifest/wheel before cached readiness, supplies the wheel explicitly to uv,
and includes wheel contents in runtime identity. The builder checks RECORD/archive safety and native
constraints, ad-hoc signs, smoke-tests, and retains licenses plus input/output receipts. Independent
source reviews are CLEAR. These completed portable checks do not establish Intel runtime success:

- `node scripts/checks/prime-runtime-wheels.mjs`: input pins, RECORD repair, reproducible ZIP and
  corruption guards pass.
- `node scripts/checks/native-kernel.mjs`: kernel-evidence rejection checks pass. Candidate readiness
  must be a valid SHA-256 and differ from the genuine old ready hash; the full baseline inventory
  must remain unchanged. The temporary wheel constraint applies only to the old bootstrap child;
  candidate probes require automatic setup with overrides absent.
- Exported reconstruction `prime-763094e1-48494616` passes
  `node scripts/checks/prime-workspace.mjs test -p pa-core --lib kernel::bootstrap::venv::`:
  15 pass, one existing live-only test ignored. The same runner's
  `clippy -p pa-core --lib --tests -- -D warnings` and `fmt --package pa-core --check` pass, with
  both real-account guards intact. Results are retained in the tool transcript, not a standalone log.

## Completed local Windows .12 run

Windows x64, Electron 44.7.0; temporary accounts, sessions and kernels remain outside real homes.
Commands below use Git Bash syntax from the managed checkout. The native engine/helper and app
builds precede the packaged run; `bf004ff` repairs only the separate benchmark seed fixture.

```sh
npm run build:engines
npm run build:auth
npm run typecheck
npm run build
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' npm run checks
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' npm run shots
node scripts/dist-qa.mjs --dir
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' \
QA_PACKAGED_EXE='C:/Users/mitte/.codex/worktrees/engine-prompts-performance/vengeance/release/qa/win-unpacked/VengeanceQA.exe' \
QA_REPORT_DIR='C:/Users/mitte/.codex/worktrees/engine-prompts-performance/vengeance/.shots/qa/0.3.3-prime12-win32-x64' \
  node scripts/qa/engines/platform-qualification.mjs
QA_TMP_ROOT='D:/Coding/vengeance-qa-engine-prompts' \
  node scripts/perf/first-navigation.mjs --label release-0.3.3-prime12-win-seed-id --runs 3
```

| Gate                   | Result / evidence                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Engine / helper builds | Pass; `.cache/0.3.3-prime12-{engines,auth}.log`                                    |
| Typecheck / app build  | Pass, renderer 19.79 s; `.cache/0.3.3-prime12-{typecheck,build}.log`               |
| Contract checks        | Pass; `.cache/0.3.3-prime12-checks.log`                                            |
| Mock screenshots       | 20 scenarios / 383 captures, visual review CLEAR; `.cache/0.3.3-prime12-shots.log` |
| QA package             | pi 14,932 files / Prime 61 files verified; `.cache/0.3.3-prime12-package.log`      |
| Packaged core          | All nine pass, no timeout or unrun suite; `.cache/0.3.3-prime12-platform.log`      |
| Built-app benchmark    | Six strict samples pass; `.cache/0.3.3-prime12-first-navigation-seed-id.log`       |

Core receipt `.shots/qa/0.3.3-prime12-win32-x64/run-Xedts5/qualification.json` covers
10:41:02–10:49:48 UTC, with a 900,000 ms per-suite deadline. The nine suites are packaged,
integration, model-isolation, system-prompts, restart-safety, stop-compaction, bash-queue,
session-recovery and resident-close. Per-suite receipts identify the actual packaged app/resources.
The transcript-recovery null/trim log is the asserted malformed-frame fixture.

Local visual review is CLEAR for all 79 core and six benchmark PNGs in
`.cache/review-bf004ff-local-native/review-receipt.json`: eight contact sheets, 14 full-size captures
(including every benchmark PNG), no carry-forward. Static visual review does not prove runtime gates.

Benchmark `.shots/perf/first-navigation/release-0.3.3-prime12-win-seed-id.json` records three fresh
processes per engine, `qualified: true`, zero scroll failures, 60-turn histories, and no forced
focus, warmup or trace diagnostics. PNGs and CPU profiles are adjacent. Its endpoint is the expected
marker visible inside transcript/window without the opening layer. This uses built output,
separately from `QA_PACKAGED_EXE`.

| Median, ms                       | Engine | Engine 2 |
| -------------------------------- | -----: | -------: |
| First conversation               |  496.6 |    908.6 |
| Second conversation, first visit |  364.5 |    542.5 |
| Cached return                    |   72.2 |     46.8 |
| First-visit renderer blocking    |      5 |       21 |

These local results do not establish another platform's speed or qualify the next combined repair.

## Current remote attempt: dd82ee3

[Release 39237513104](https://github.com/LuciferMornens/vengeance/actions/runs/39237513104) fails all
five build jobs. Four platforms pass the nine core suites; Intel stops during wheel verification.
No final native upgrade, Intel runtime, remote benchmark or package-install pass is claimed.

| Native platform / runner                            | Core / Dock              | Later result                                                                          |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `win32-x64` / `windows-2025`                        | Nine core pass           | Benchmark seed omits explicit agent ID; fixed in bf004ff, locally rerun               |
| `darwin-arm64` / `macos-15`                         | Nine core and Dock pass  | Upgrade fixture fails the QA-root sibling-boundary check; e8d06fa awaits native rerun |
| `darwin-x64` / `macos-15-intel`                     | No runtime qualification | Wheel compiles; verifier rejects LC_ID_DYLIB self-name; 23dff5c awaits native rerun   |
| `linux-x64` / `ubuntu-24.04`, 22.04 container       | Nine core pass           | Upgrade fixture fails the QA-root sibling-boundary check; e8d06fa awaits native rerun |
| `linux-arm64` / `ubuntu-24.04-arm`, 22.04 container | Nine core pass           | Upgrade fixture fails the QA-root sibling-boundary check; e8d06fa awaits native rerun |

The Intel build produces `cryptography-50.0.2-cp39-abi3-macosx_13_0_x86_64.whl` before the verifier
failure. Compilation is evidence of that stage only: installed import, signatures, packaged kernel
and official-baseline upgrades still need a clean native run.

macOS arm64 Dock evidence at
`.cache/ci-39237513104/mac-arm64/qa/release/background-applications/background-apps-shots/background-apps-evidence.json`
records 238 OS frames over 23.346 s, seven checkpoints, zero unexpected foreground applications,
and the same Prime PID 71015 after reconnect. This is an identified platform/scenario pass, not an
Intel or next-head Dock result. Artifacts are retained under `.cache/ci-39237513104`.

Current CI Windows/Linux mock visual review is CLEAR for all 383 captures per platform under
`.cache/ci-39237513125/review-{win,linux}`. macOS arm64 core/Dock review is CLEAR in
`.cache/ci-39237513104/review-mac-native/review-receipt.json`, covering 79 core plus two background
PNGs and the OS observations; 14 core captures use verified identical-pixel carry-forward. These
receipts do not qualify Intel, upgrades or unobserved desktop behavior.

## Local artifact identities

These hashes identify the local .12 receipt and benchmark, not final shipping installers or the
unqualified Intel wheel. Full input fingerprints, revisions and patch hashes remain in the receipts.

| Windows artifact     | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| QA executable        | `6567a92c70f76c00791776d832921f3e06364576c307ba9155fcf266ba9331b0` |
| Built main           | `76a2f4e8d922e4d8b15e2d8475decd49fc9f89445fd99ebd4ddee745715ec285` |
| Built renderer index | `facedcab9f2b1f9f9065b08cbcfe42d05097c31f8c6480798d6f61eff8ad1564` |
| pi .2 payload        | `97f796c58c176d6f78f1bbb45564c26225d53826bcb34b479865900002d18a39` |
| Prime .12 payload    | `e0a9ca3646e5a9fd95057d0b0390bdb9bb8674d8ea74b0f0d93223d3c73cddc8` |
| Prime .12 executable | `e5625fd35d5b3720455c6a80a98c787eeb55f48a1ef83f9506ee00ec8372131b` |

## Retained historical evidence

The [preceding checkpoint](https://github.com/LuciferMornens/vengeance/blob/dd82ee33b65320062fb43a8e6923ed968471630a/docs/RELEASE-QUALIFICATION-0.3.3.md)
preserves exact commands, hashes, authenticated archive IDs/digests, failures and visual receipts for
the .11 local run and failed release attempts `e3cbf5d`, `835f034` and `404d24d`. The latter had green
ordinary CI/CodeQL and core/Dock/upgrade passes within its scope, but failed overall release qualification.
Its 79 Windows native PNGs have CLEAR static review in
`.cache/ci-39229025591/review-win-native/review-receipt.json` (seven sheets, 14 full-size captures,
no carry-forward). Its macOS/Linux native and mock visual coverage remains scoped to those artifacts.

The [original prompt/restart qualification](ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md) and
[navigation comparison](PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md) retain their own source scope.
Historical Windows Engine first/second visits improve 825/544 → 491/340 ms; Engine 2 is mixed at
877/487 → 901/549 ms. Renderer blocking falls 128 → 4 and 122 → 19 ms, cached returns add 20–25 ms,
and a roughly 210 ms startup gap remains. The separate older .11 local benchmark records
494.4/342.5/71.6 ms for Engine and 860.1/571.9/49.9 ms for Engine 2. None qualifies later changes or
an unmeasured cross-platform improvement.

## Remaining gates and limits

- Qualify the combined repairs on the final source: all five native builds/core suites, both macOS
  Dock witnesses, official .10 → .12 upgrades on macOS/Linux, and actual Intel loaded
  cryptography/OpenSSL, automatic venv and old-cache refresh with baseline inventory unchanged.
- Complete final-head ordinary CI/CodeQL, five-platform benchmarks and visual review, macOS
  signature/zip/dmg verification, Linux glibc 2.35 and package-install gates. Retain final native/helper
  identities, desktop/upgrade receipts, shipping-file hashes, `SHA256SUMS` and provenance.
- Core QA excludes paid-provider inference, completed external OAuth, installer/window-manager and
  AppImage-mount lifecycle coverage. CI does not establish physical Mac/compositor behavior. macOS
  remains ad-hoc signed, without notarization. Process-cold samples do not flush filesystem caches;
  historical synthetic scroll-follow geometry and startup-gap limits remain in the performance report.
- By user request, stopped diagnostic folders `vengeance-qa-run-rbuzFd` and
  `vengeance-qa-engines-D7ECf0` remain under `D:/Coding/vengeance-qa-engine-prompts`. They are not active
  processes or passing evidence. Real user accounts remain untouched.
