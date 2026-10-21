# Vengeance 0.3.6 qualification checkpoint

21 October 2026. This checkpoint records local verification on Windows x64, the CI and release dry
run of the pull request since 0.3.5, the release commit's CI and the tag run. The tag run and the
published release's receipts identify the qualified shipping bytes and supersede this checkpoint where
source or artifacts differ.

## Source and scope

| Boundary                 | Commit                                     |
| ------------------------ | ------------------------------------------ |
| Official 0.3.5 release   | `650376967f6bd425fe4592f365cd036bc565e3c7` |
| PR #27 head tested by CI | `2ee9c4325fab719c698947033ec7c985566a5c49` |
| PR #27 merged on `main`  | `cbf4c4faaf43d70354a7036a5b88eab53f438d6b` |
| `v0.3.6` (PR #28 merged) | `f9e1cead94c7cd8e733c17d405c560b67d1a433e` |

Since 0.3.5: the workspace switcher leaves out folders that no longer exist, and the sidebar lists
main conversations with subagent sessions under them (#27).

Engine is unchanged at `1.3.0+vengeance.4`, based on stable `v1.3.0` at
`71023aec1546d6d677a65669c5665c0927ce0dd0` with nine applied patches. Engine 2 is unchanged at
`0.10.0+vengeance.13`, based on stable `v0.10.0` at `763094e1b6a7c17450ee8399b06cda1853847ca5` with
24 ordered patches. The Engine 2 sign-in helper source is unchanged. `engines.lock.json` is the
source of truth for both builds.

## Review

The pull request went through three review rounds by an independent reviewer reading the diff, the
specification and, read-only, a real account's workspace preferences and session folders. The first
two rounds asked for changes and the third approved; its two low follow-ups (a quiet scan when the
switcher opens, and the fallback after removing the active workspace) landed before the merge.

## Local verification

Run on Windows 11 x64 at the final head with temporary accounts; see
[the QA guide](../scripts/qa/README.md).

- `npm run typecheck`, `npm run build` and `npm run checks`, including the new `sidebar-lists` check
  (subagent nesting, forks, pinned sessions, orphans and parent loops; workspace pruning for complete
  and incomplete scans and for gone, opened, active, pinned, restored and hidden folders; hidden gone
  folders) and the Engine 2 saved-discovery check.
- `npm run shots`: 407 shots, with the sessions and workspace PNGs reviewed. The `transcript-recovery`
  renderer error is intentional and asserted by that scenario.
- `scripts/qa/performance/workspaces.qa.mjs`, including a deleted folder and a deleted folder tree
  with history that are not discovered, a never-opened folder that leaves with its last session, and
  an opened folder left out of the switcher while it is deleted and back after the switcher opens
  again.
- `scripts/qa/sessions/history.qa.mjs`, `scripts/qa/engines/subagent-lineage.qa.mjs`,
  `scripts/qa/performance/session-listing.qa.mjs` and `scripts/qa/performance/native-isolation.qa.mjs`.

## CI and release dry run

PR #27 at `2ee9c43`:

- [CI 39618234235](https://github.com/LuciferMornens/vengeance/actions/runs/39618234235) passes on the
  first attempt: typecheck, build and workflow lint, dependency review, engines, and checks and
  shots on `win32-x64`, `darwin-arm64` and `linux-x64`.
- The [Release dry run 39618234511](https://github.com/LuciferMornens/vengeance/actions/runs/39618234511)
  passes Version, the five builds (`win-x64`, `mac-arm64`, `mac-x64`, `linux-x64`, `linux-arm64`)
  and the deb, rpm and pacman install jobs on the first attempt; the draft job is skipped as on every
  dry run.
- On `main`, [CI 39624530547](https://github.com/LuciferMornens/vengeance/actions/runs/39624530547)
  passes for `cbf4c4f`.

No build step continues on error, so each passing build also passed its update-feed check, the glibc
2.35 gate (Linux), signature, zip and dmg checks (macOS), the nine packaged core suites, the Dock
visibility check (macOS), the official 0.3.2 to candidate Engine 2 upgrades (macOS and Linux), the
first-navigation benchmark and the provenance receipt. These dry-run packages are numbered 0.3.5.

## Release commit `6f2f4d7`

The version-bump commit ([PR #28](https://github.com/LuciferMornens/vengeance/pull/28)) passed
[CI 39647845958](https://github.com/LuciferMornens/vengeance/actions/runs/39647845958) and its
[Release dry run 39647845947](https://github.com/LuciferMornens/vengeance/actions/runs/39647845947)
(Version, the five builds and the deb, rpm and pacman install jobs), both on the first attempt. It
merged as `f9e1cea`, and [CI 39649394770](https://github.com/LuciferMornens/vengeance/actions/runs/39649394770)
passes on `main`.

## Tag run

`v0.3.6` points at `f9e1cea`. The
[tag run 39652126107](https://github.com/LuciferMornens/vengeance/actions/runs/39652126107) passed
Version, the five builds, the deb, rpm and pacman install jobs and the draft job on the first
attempt. Every build built both engines from source; none restored cached payloads. The draft
carried the 24 expected files (packages, blockmaps, the four update files and `SHA256SUMS`, which
lists the other 23), its body was `docs/RELEASE-0.3.6.md`, and every update file named version 0.3.6.
It was published as the latest release on 21 October 2026.

## Not verified

- Visual review of the CI screenshots and the qualification, benchmark and provenance artifacts of
  the runs above; their counts are not recorded here. No benchmark comparison with 0.3.5 is made.
- Workspace discovery against a real account's history: the QA suites use temporary accounts, and
  the review read a real account's folders without running the app on them.
- macOS and Linux mount points and removable volumes: the gone-folder rule was exercised on Windows
  only.
- An upgrade from the official 0.3.5 package: the release upgrade gate stages 0.3.2 (`.10`) as its
  baseline. Windows has no packaged upgrade gate.
- Physical desktops, window managers and installer or AppImage lifecycles beyond the CI runners.
  macOS packages remain ad-hoc signed without notarization.
