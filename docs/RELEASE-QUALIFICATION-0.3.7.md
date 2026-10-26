# Vengeance 0.3.7 qualification checkpoint

26 October 2026. This checkpoint records local verification on Windows x64 and the CI and release dry
run of the pull request since 0.3.6. The release commit's CI, the tag run and the published release's
receipts identify the qualified shipping bytes and supersede this checkpoint where source or artifacts
differ.

## Source and scope

| Boundary                 | Commit                                     |
| ------------------------ | ------------------------------------------ |
| Official 0.3.6 release   | `f9e1cead94c7cd8e733c17d405c560b67d1a433e` |
| PR #33 head tested by CI | `8212009dcbfa73e73e1a1e03ba1736839b059c08` |
| PR #33 merged on `main`  | `53f89eaa345bbc51f1d58a5bf2ca6c3006ea0690` |

Since 0.3.6: both engines move to their newest stable upstream releases, a provider overload reads
as the provider's capacity rather than the account's rate limit and offers another model, and
Abliteration lists all four models (#33).

Engine is `1.4.0+vengeance.1`, based on stable `v1.4.0` at
`4a080252f06caf63a525d7873c5d94d3c23887e0` with nine applied patches. Engine 2 is
`0.10.1+vengeance.1`, based on stable `v0.10.1` at `8aac8692456c00c01d4e53e60e6d3347a3506559` with
21 ordered patches; the Engine 2 sign-in helper links the same patched revision. `engines.lock.json`
is the source of truth for both builds, and
[the engine audit](ENGINE-STABLE-AUDIT-2026-10-26.md) records the rebase, native test and app QA
results in detail.

## Local verification

Run on Windows 11 x64 with temporary accounts; see [the QA guide](../scripts/qa/README.md).

- `npm run typecheck`, `npm run build`, `npm run checks`, including the provider-overload parsing
  check, and the bundled-engines check.
- `npm run shots`, including the new `provider-overload` shots of the overload card and the model
  picker its **Change model** button opens.
- Engine's isolated `check` and full suite, and Engine 2's isolated native workspace with clippy and
  its kernel end-to-end tests. The failures that remain also fail on the unpatched upstream releases
  or pass alone; the audit lists them.
- The dual-engine integration suite and 14 more app QA suites with fake providers, and
  `scripts/qa/engines/packaged.qa.mjs` against a `npm run dist:qa -- --dir` package.
- `scripts/qa/engines/resident-upgrade.qa.mjs` with an installed 0.3.6 Engine 2
  (`0.10.0+vengeance.13`) as its baseline and the staged `0.10.1+vengeance.1` as its candidate: 11
  checks, covering the Python tool under its old and new names.
- With real accounts, in temporary folders without saved sessions: Kimi K3.1 Pro and K3.1 Pro
  Highspeed answered in the built app at `low`, `high` and `max`, and the Abliteration suite passed
  against the built Engine.

## CI and release dry run

PR #33's first head, `35fdfc7`, failed the Linux and Apple silicon builds' Engine 2 upgrade gate: its
Python probe called `python_repl` on the 0.3.2 baseline, which declares `ipython`. The probe now calls
the tool the running Engine 2 declares. At `8212009`:

- [CI 40369478429](https://github.com/LuciferMornens/vengeance/actions/runs/40369478429) passes on the
  first attempt: typecheck, build and workflow lint, dependency review, engines, and checks and
  shots on `win32-x64`, `darwin-arm64` and `linux-x64`.
- The [Release dry run 40369478448](https://github.com/LuciferMornens/vengeance/actions/runs/40369478448)
  passes Version, the five builds (`win-x64`, `mac-arm64`, `mac-x64`, `linux-x64`, `linux-arm64`)
  and the deb, rpm and pacman install jobs on the first attempt; the draft job is skipped as on every
  dry run.
- On `main`, [CI 40410842861](https://github.com/LuciferMornens/vengeance/actions/runs/40410842861)
  passes for `53f89ea`.

No build step continues on error, so each passing build also passed its update-feed check, the glibc
2.35 gate (Linux), signature, zip and dmg checks (macOS), the nine packaged core suites, the Dock
visibility check (macOS), the official 0.3.2 to candidate Engine 2 upgrades (macOS and Linux), the
first-navigation benchmark and the provenance receipt. These dry-run packages are numbered 0.3.6.

## Not verified

- Visual review of the CI screenshots and the qualification, benchmark and provenance artifacts of
  the runs above; their counts are not recorded here. No benchmark comparison with 0.3.6 is made.
- Real-account behavior beyond the Kimi and Abliteration turns above, and a live provider overload:
  the overload card was exercised with the recorded Kimi error.
- Packaged QA on macOS and Linux outside CI. Windows has no packaged upgrade gate; the Windows
  resident upgrade above ran against the staged candidate.
- Physical desktops, window managers and installer or AppImage lifecycles beyond the CI runners.
  macOS packages remain ad-hoc signed without notarization.
