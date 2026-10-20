# Vengeance 0.3.5 qualification checkpoint

20 October 2026. This checkpoint records the CI and release dry runs of the two pull requests since
0.3.4 and local verification on Windows x64. The release commit's CI, the tag run and the published
release's receipts identify the qualified shipping bytes and supersede this checkpoint where source
or artifacts differ.

## Source and scope

| Boundary                 | Commit                                     |
| ------------------------ | ------------------------------------------ |
| Official 0.3.4 release   | `214293e73fcdd3a04a49b375f7802f30bbc1d807` |
| PR #23 head tested by CI | `8175bca09974f4ea1dd8c1f0cef5046c64415d1e` |
| PR #23 merged on `main`  | `70ca1116d3da4ce5c9827d2d1e6c400c165236a6` |
| PR #24 head tested by CI | `43c536ecccaabe27c7fba8640beaeeb34066a222` |
| PR #24 merged on `main`  | `3ab00720d897d6599c175e6cc68a8f42606fc13a` |

Since 0.3.4: refused Engine sign-ins and faster CI and dry runs (#23), and a queue-deletion QA fix
(#24).

Engine is `1.3.0+vengeance.4`, based on stable `v1.3.0` at
`71023aec1546d6d677a65669c5665c0927ce0dd0` with nine applied patches; it adds
`0010-oauth-refresh-rejection`. Engine 2 is unchanged at `0.10.0+vengeance.13`, based on stable
`v0.10.0` at `763094e1b6a7c17450ee8399b06cda1853847ca5` with 24 ordered patches. The Engine 2
sign-in helper source is unchanged. `engines.lock.json` is the source of truth for both builds.

## Local verification

Run on Windows 11 x64 with temporary accounts; see [the QA guide](../scripts/qa/README.md).

PR #23, as its description records:

- `npm run typecheck`, `npm run checks`, `npx electron-vite build` and `npm run shots`, with the
  PNGs reviewed.
- Engine native suites through the isolated harness: `oauth-refresh-rejection` (24 tests),
  `model-runtime-oauth-rejection` (13 tests, 20 runs in a row) and the model runtime, registry,
  resolver, session prompt and MCP OAuth suites, 231 tests in all, plus the Engine's own Biome and
  tsc check.
- `scripts/qa/auth/refused-sign-in.qa.mjs` against the real Engine `.4`: 9 of 9 steps.

PR #24:

- `scripts/qa/engines/bash-queue.qa.mjs` passed five times in a row. Fault injection in a scratch
  copy showed a missed click being repeated once and a refused removal failing at once with the
  toast text.
- `npm run typecheck`, `npm run checks` and `npm run build` pass. It changes no app code.

## CI and release dry runs

PR #23 at `8175bca`:

- [CI 39460049952](https://github.com/LuciferMornens/vengeance/actions/runs/39460049952) passes.
- The [Release dry run 39460049772](https://github.com/LuciferMornens/vengeance/actions/runs/39460049772)
  passes Version, the five builds (`win-x64`, `mac-arm64`, `mac-x64`, `linux-x64`, `linux-arm64`)
  and the deb, rpm and pacman install jobs; the draft job is skipped as on every dry run. Its
  `mac-arm64` build passed on the second attempt: the first failed in the queue-deletion step that
  PR #24 addresses.
- On `main`, [CI 39473212125](https://github.com/LuciferMornens/vengeance/actions/runs/39473212125)
  passes for `70ca111`.

PR #24 at `43c536e`:

- [CI 39482023028](https://github.com/LuciferMornens/vengeance/actions/runs/39482023028) passes.
- The [Release dry run 39482023084](https://github.com/LuciferMornens/vengeance/actions/runs/39482023084)
  passes Version and the five builds on its first attempt, including the queue-deletion step on both
  macOS builds, and the deb, rpm and pacman install jobs.

No build step continues on error, so each passing build also passed its update-feed check, the glibc
2.35 gate (Linux), signature, zip and dmg checks (macOS), the nine packaged core suites, the Dock
visibility check (macOS), the official 0.3.2 to candidate Engine 2 upgrades (macOS and Linux), the
first-navigation benchmark and the provenance receipt. These dry-run packages are numbered 0.3.4.

## Not verified

- Visual review of the CI screenshots and the qualification, benchmark and provenance artifacts of
  the runs above; their counts are not recorded here. No benchmark comparison with 0.3.4 is made.
- A refusal from a live provider's token endpoint: the QA suite and native tests use a local endpoint
  that answers `invalid_grant`.
- An upgrade from the official 0.3.4 package: the release upgrade gate stages 0.3.2 (`.10`) as its
  baseline. Windows has no packaged upgrade gate.
- Paid-provider inference and completed external OAuth, including MCP server sign-in.
- Physical desktops, window managers and installer or AppImage lifecycles beyond the CI runners.
  macOS packages remain ad-hoc signed without notarization.
