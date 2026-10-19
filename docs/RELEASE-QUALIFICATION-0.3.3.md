# Vengeance 0.3.3 qualification checkpoint

19 October 2026. **Final release qualification is pending; publication remains gated.** This PR
checkpoint covers local product fix `3277563`, benchmark regression `5fee2cc` and QA metadata repair
`5df934a`, plus remote results for earlier head `556da0c`. It does not claim the new head passes the five-platform matrix.
Final PR/tag-run results and published-release receipts recorded in the PR/release body govern the
qualified shipping bytes and supersede this checkpoint where source or artifacts differ.

## Source and scope

| Boundary                               | Commit                                     |
| -------------------------------------- | ------------------------------------------ |
| Official 0.3.2 comparison base         | `8b2319880580893356d7cc7d2fbc721c08936bf9` |
| Remote candidate                       | `556da0c2b4a1f822cc022b17a9f99a110416c5f9` |
| Supported cold-history reader fix      | `3277563678d84e21d4e1e6760fd7eaa724c31745` |
| Settled trusted mouse-wheel regression | `5fee2cc41113d6624be19e65211e92a7428cea04` |
| Optional local-wheel metadata verifier | `5df934a810f9de0c2e010f887b01ef477b7e29dd` |

Both product source reviewers report CLEAR; the QA metadata repair has code-review and coordinator
review CLEAR. Engine remains `1.3.0+vengeance.2`, based on pi
`71023aec1546d6d677a65669c5665c0927ce0dd0`. Engine 2 remains `0.10.0+vengeance.12`, based on Prime
`763094e1b6a7c17450ee8399b06cda1853847ca5` with 23 ordered patches. The reader fix and local-wheel
metadata verifier repair add no native engine patch or account/session/helper format change.

At `556da0c`, [CI 39241986916](https://github.com/LuciferMornens/vengeance/actions/runs/39241986916)
passes all eight jobs and [CodeQL 39241983322](https://github.com/LuciferMornens/vengeance/actions/runs/39241983322)
passes all three analyses. These analyses cover that source, not the later reader/verifier changes.
Successful analyses do not establish absence of vulnerabilities.

The CI screenshot corpus contains 383 captures each on Windows/Linux and 363 on macOS. The macOS
runner's 1024×684 work area excludes 20 larger PNG variants. Separately, 31 geometry-sweep steps
are skipped, including requested 740-pixel heights; these are not the 20 absent PNGs.
`.cache/556-ci-job-118033315591.log` records 35 display-size skip lines: 31 sweep steps and four
variant-size skips. Visual review of all 363 provided macOS captures is CLEAR in
`.cache/ci-39241986916/review-mac/review-receipt.json`: 266 directly reviewed captures plus 97
prior-only exact-RGBA carries, zero unreviewed. The 20 absent PNGs remain outside its scope.

## Supported cold-history scrolling defect and repair

A trusted mouse-wheel-only upward scroll immediately after cold-opening a rich Engine history was
reproduced pulling the reader back to the latest message. This is a supported-input product defect,
not merely the older synthetic scroll-follow diagnostic. Its exact relationship to archived
Windows/macOS benchmark failures is not inferred from that reproduction alone.

The product fix keeps pinned renders deferred but commits virtualized size and transform updates
synchronously during reader scroll compensation. This prevents bottom clamping against the old
sizer from repinning the transcript. Separate trusted mouse-wheel comparison traces show the old
final distance from bottom at 0 with Jump to latest absent, versus 5,379 px and Jump to latest visible
after repair. Evidence is
`.cache/wheel-order-2026-10-19T11-44-56-181Z/trace.json` and
`.cache/wheel-order-2026-10-19T11-48-48-519Z/trace.json`.
The strengthened benchmark checks a settled reader after trusted mouse-wheel input and returning to latest;
all six local samples pass. This does not reclassify every older diagnostic as the same cause.

## Local validation of the reader fix

Commands use isolated `QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts` where applicable; real
account homes are not test fixtures. The local app build invokes engine/helper preparation.

| Command / gate                                                         | Result / evidence                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run typecheck`                                                    | Pass; `.cache/typecheck-reader-flush.log`                               |
| `npm run build`                                                        | Pass, renderer 19.98 s; `.cache/build-reader-flush.log`                 |
| `QA_TMP_ROOT=... npm run checks`                                       | Combined repair pass; `.cache/0.3.3-reader-flush-kernel-checks.log`     |
| `QA_TMP_ROOT=... npm run shots`                                        | 20 scenarios / 383 captures pass; `.cache/0.3.3-reader-flush-shots.log` |
| `node scripts/perf/first-navigation.mjs --label reader-flush --runs 3` | Six strict samples pass; `.cache/reader-flush-first-navigation.log`     |

Benchmark `.shots/perf/first-navigation/reader-flush.json` records `qualified: true`, zero scroll
failures, three fresh processes per engine and 60-turn saved histories. All six samples pass the
trusted mouse-wheel reader and Jump to latest checks. It uses built output, separately from packaged QA,
without forced focus, warmup or trace diagnostics; PNGs and CPU profiles are adjacent.

| Visible endpoint median, ms      | Engine | Engine 2 |
| -------------------------------- | -----: | -------: |
| First conversation               |  486.0 |    920.8 |
| Second conversation, first visit |  346.6 |    566.5 |
| Cached return                    |   70.3 |     47.6 |

`.cache/review-reader-flush/review-receipt.json` is CLEAR for all six benchmark PNGs and both
trusted mouse-wheel comparison PNGs, each directly inspected at original resolution with no carry-forward.
The complete 383-capture visual re-review is CLEAR in
`.cache/review-reader-flush-shots/review-receipt.json`: 273 unique directly reviewed captures plus
114 exact PNG SHA-256/dimension carries minus four overlaps, covering all 20 scenario groups with
zero unreviewed. Receipt SHA-256 is
`07afc433a47c383519d2617a65dd489b116d4ea97e2bf8da1cdde43443e185ec`.
These are static screenshot reviews; they do not prove runtime behavior or qualify new-head native
runs. The benchmark/trace records supply their separate evidence.

| Local built artifact | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Main                 | `76a2f4e8d922e4d8b15e2d8475decd49fc9f89445fd99ebd4ddee745715ec285` |
| Renderer index       | `528c12feab6c9a1897d1916f585f1ca296c83a2cb010233a4a770fcdb133d593` |
| Engine .2 payload    | `97f796c58c176d6f78f1bbb45564c26225d53826bcb34b479865900002d18a39` |
| Engine 2 .12 payload | `e0a9ca3646e5a9fd95057d0b0390bdb9bb8674d8ea74b0f0d93223d3c73cddc8` |
| Benchmark JSON       | `ae0c0c7b56df61f2cd39cc4fd4d2e4bfb97ed1d9ab3498fdc9cd0313a78596e3` |

These identify the local test, not final installers. The prior Windows packaged core run
`.shots/qa/0.3.3-prime12-win32-x64/run-Xedts5/qualification.json` passed all nine suites with
Engine 2 .12 before this reader change; it is not a packaged rerun of the new renderer.

## Remote matrix at 556da0c

[Release 39241986909](https://github.com/LuciferMornens/vengeance/actions/runs/39241986909) completes
both Linux build jobs successfully. Windows/macOS arm64 benchmark failures and the Intel integration
verifier failure prevent overall release qualification. Later gates not run are not passes.

| Native platform / runner                            | Core / Dock                                       | Upgrades / benchmark / artifacts                                                           |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `win32-x64` / `windows-2025`                        | Nine core pass                                    | Benchmark fails; no completed shipping gate                                                |
| `darwin-arm64` / `macos-15`                         | Nine core and Dock pass                           | Both official upgrades pass; benchmark fails                                               |
| `darwin-x64` / `macos-15-intel`                     | Packaged suite pass; integration 36/37 steps pass | Metadata verifier fails; seven remaining core suites, Dock, upgrades and benchmark not run |
| `linux-x64` / `ubuntu-24.04`, 22.04 container       | Nine core pass                                    | Both upgrades, six benchmark samples and build/provenance gates pass                       |
| `linux-arm64` / `ubuntu-24.04-arm`, 22.04 container | Nine core pass                                    | Both upgrades, six benchmark samples and build/provenance gates pass                       |

Retained receipts are under `.cache/ci-39241986909`:

- Core: `engine-qualification-<platform>/qa/release/engine-qualification`, including Windows
  `run-3BsYWM`, macOS arm64 `run-uTtO3D`, Intel `run-sPb7vc`, Linux x64 `run-1AB8N9` and arm64
  `run-H3l2CB`.
- Official .10 → .12 upgrades: macOS arm64 `run-pHikkQ`, Linux x64 `run-cPBVPy` and arm64
  `run-KwYB4y` under each platform's `qa/release/engine-upgrade`.
- Linux benchmarks: `engine-qualification-linux-<arch>/perf/first-navigation/release-linux-<arch>.json`,
  both `qualified: true` with zero scroll failures. Shipping-file/native/helper hashes are in
  `provenance-linux-<arch>/release-receipt.json`.
- Current static review receipts: `review-win-native`, `review-mac-native`, `review-intel-native`
  and `review-linux-native/coverage-receipt.json`. Intel's 29 supplied PNGs are visually CLEAR,
  with the runtime qualification explicitly FAIL/INCOMPLETE. Linux review covers 202 core/upgrade/
  benchmark PNGs, including verified exact-image carry-forward.

Linux provenance records tested PR merge commit `01c1cc8ccab946ef554011f00c83e344bc360f89`.
The authenticated tree proof in the Linux review confirms it has the same Git tree as `556da0c`;
this does not identify the later reader-fix bytes as tested remotely.

## Intel kernel evidence and metadata verifier repair

The Intel source-built cryptography `50.0.2` wheel with static OpenSSL `4.0.3` now passes native
engine/helper building and the packaged suite. Before the integration verifier's final metadata
assertion, actual-kernel checks establish the cryptography/OpenSSL versions, signed extension hash,
x86_64 architecture, fresh owned automatic venv and absence of bootstrap overrides. The sole failed
integration step throws `Cannot read properties of undefined (reading 'sha256')` while assuming
`archive_info.hashes` exists. The whole integration gate remains failed.

Raw CI `direct_url.json` was not retained, so an observed empty metadata object is not claimed for
that artifact. A controlled public-uv local-wheel reproduction does record `archive_info: {}` in
`.cache/native-kernel-uv-local-wheel-repro.json`; it uses installed Windows uv `0.12.13`.
Independent audit of exact CI uv `0.13.1` source and PyPA metadata rules confirms the hash field is
optional for this local-wheel path. This source audit is separate from the CI observation.

The reviewed QA repair `5df934a` validates canonical local file URL identity, hashes the actual source wheel
(including a cached copy), and validates every digest present in metadata without requiring absent
optional fields. Existing loaded-native/venv/override and whole-baseline-inventory checks remain.
Full combined contract checks pass in `.cache/0.3.3-reader-flush-kernel-checks.log`; the native rerun
remains pending. This changes QA, not the engine patch.

## Historical evidence and limits

The [preceding checkpoint](https://github.com/LuciferMornens/vengeance/blob/556da0c2b4a1f822cc022b17a9f99a110416c5f9/docs/RELEASE-QUALIFICATION-0.3.3.md)
retains previous local commands/hashes, portable wheel/native regressions, authenticated artifact
identities and failed release attempts. The
[original prompt/restart qualification](ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md) and
[navigation comparison](PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md) retain their own source scope.
Historical Windows Engine first/second visits improve 825/544 → 491/340 ms; Engine 2 is mixed at
877/487 → 901/549 ms. Renderer blocking falls 128 → 4 and 122 → 19 ms; cached returns add 20–25 ms
and a roughly 210 ms startup gap remains. These do not establish cross-platform speed improvements.
Older synthetic diagnostic limitations remain historical evidence, separately from the supported
cold-wheel product defect reproduced and fixed above.

Existing moderate [Dependabot #2](https://github.com/LuciferMornens/vengeance/security/dependabot/2)
for `sprintf-js` predates this PR, is development/build-transitive, has no offered patched version,
and has no shipped path found in the reviewed graph. This is not a broad security guarantee.

## Final gates

Publication requires final-source CI/CodeQL, native engines/helper and nine core suites on all five
platforms, both macOS Dock witnesses, official macOS/Linux .10 → .12 upgrades with actual Intel kernel
and old-cache refresh, strengthened platform benchmarks and visual review. Signature/zip/dmg,
glibc 2.35, package-install and shipping provenance/hash gates must also complete. Final PR/tag-run
and published-release receipts must identify the exact app/native/helper bytes.

Core QA excludes paid-provider inference and completed external OAuth. CI observations do not prove
unobserved physical desktops, compositor/window-manager or installer/AppImage-mount lifecycles.
macOS remains ad-hoc signed without notarization. Process-cold samples do not flush filesystem caches.
Real user accounts remain untouched. By user request, stopped diagnostic folders
`vengeance-qa-run-rbuzFd` and `vengeance-qa-engines-D7ECf0` remain under
`D:/Coding/vengeance-qa-engine-prompts`; they are not active processes or passing evidence.
