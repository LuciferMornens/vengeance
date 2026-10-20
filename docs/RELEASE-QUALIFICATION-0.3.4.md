# Vengeance 0.3.4 qualification checkpoint

20 October 2026. **The `v0.3.4` tag run is pending; publication remains gated on it.** This
checkpoint records local verification of the 0.3.4 changes and the CI of
[PR #21](https://github.com/LuciferMornens/vengeance/pull/21) at head `677b3e4`, both before the
version bump. The tag run and the published release's receipts identify the qualified shipping
bytes and supersede this checkpoint where source or artifacts differ.

## Source and scope

| Boundary                       | Commit                                     |
| ------------------------------ | ------------------------------------------ |
| Official 0.3.3 release         | `4aa0527e355c8be1aedd97762c39434952710a11` |
| `main` before PR #21 (#20)     | `a997fef2bceadb48777439d0c2c52ded9218a92b` |
| PR #21 head tested by CI below | `677b3e4282efb105f85d77f6c2867b47f7d23e06` |

Since 0.3.3: per-conversation instructions and live MCP status (#21), graceful QA daemon cleanup
(#20), dependency updates (#17), CI automation changes (#19) and a documentation path fix (#18).

Engine is `1.3.0+vengeance.3`, based on stable `v1.3.0` at
`71023aec1546d6d677a65669c5665c0927ce0dd0` with eight applied patches; it adds
`0009-mcp-host-state`. Engine 2 is `0.10.0+vengeance.13`, based on stable `v0.10.0` at
`763094e1b6a7c17450ee8399b06cda1853847ca5` with 24 ordered patches; it adds `0024-mcp-live-status`.
Both patches are additive and leave `/mcp`, prompts and saved formats unchanged. The Engine 2
sign-in helper source is unchanged. `engines.lock.json` is the source of truth for both builds.

## Local verification

Run on Windows 11 x64 on the development branch mirrored as PR #21. The QA harness runs each suite
with temporary accounts; see [the QA guide](../scripts/qa/README.md).

| Gate                      | Result                                    |
| ------------------------- | ----------------------------------------- |
| `npm run typecheck`       | Pass                                      |
| `npm run checks`          | 319 passing                               |
| `npx electron-vite build` | Pass                                      |
| `npm run shots`           | 23 scenario files, 403 PNGs, all reviewed |
| `npm run e2e:bridge`      | Pass                                      |

Real-engine QA suites, run one at a time:

| Suite                                       | Result                |
| ------------------------------------------- | --------------------- |
| `scripts/qa/ext/mcp.qa.mjs` (Engine)        | 25 steps pass         |
| `scripts/qa/engines/mcp-live.qa.mjs` (new)  | 9 steps pass          |
| `scripts/qa/settings/system-prompts.qa.mjs` | Pass on both engines  |
| `scripts/qa/engines/engine-switch.qa.mjs`   | 5 checks pass         |
| `scripts/qa/engines/restart-safety.qa.mjs`  | 12 native checks pass |
| `scripts/qa/engines/integration.qa.mjs`     | 37 steps pass         |

Native engine tests:

- Engine: the native MCP suites pass, 130 tests with one skipped.
- Engine 2: the `pa-types`, `pa-daemon` and `pa-core` library tests pass, as do `cargo fmt` and
  `clippy`. The kernel reconnect test passes against a real kernel.
- Engine 2's Python `mcp_status` tests pass. The same Windows run reports 52 failures in existing
  REPL tests, identical with and without patch 0024; they are unrelated to it and not fixed here.

## PR #21 CI at `677b3e4`

- [CI 39357286133](https://github.com/LuciferMornens/vengeance/actions/runs/39357286133) passes all
  eight jobs: typecheck, build and workflow lint; dependency review; engines on `win32-x64`,
  `darwin-arm64` and `linux-x64`; and checks and shots on the same three platforms.
- [CodeQL 39357283008](https://github.com/LuciferMornens/vengeance/actions/runs/39357283008) passes
  the actions, JavaScript/TypeScript and Rust analyses. Passing analyses do not establish the
  absence of vulnerabilities.
- The [Release dry run 39357286107](https://github.com/LuciferMornens/vengeance/actions/runs/39357286107)
  passes Version, the five builds (`win-x64`, `mac-arm64`, `mac-x64`, `linux-x64`, `linux-arm64`)
  and the deb, rpm and pacman install jobs; the draft job is skipped as on every dry run. The
  `mac-x64` build passed on its second attempt; the first failed on a GitHub artifact upload
  (`ETIMEDOUT`).

No build step continues on error, so each passing build also passed its update-feed check, the glibc
2.35 gate (Linux), signature, zip and dmg checks (macOS), the nine packaged core suites, the Dock
visibility check (macOS), the official 0.3.2 to candidate Engine 2 upgrades (macOS and Linux), the
first-navigation benchmark and the provenance receipt. These dry-run packages are numbered 0.3.3.

## Release commit `41bc0ce`

The version-bump commit passed [CI 39381510064](https://github.com/LuciferMornens/vengeance/actions/runs/39381510064)
and merged as `bf84fd1`. Its
[Release dry run 39381510068](https://github.com/LuciferMornens/vengeance/actions/runs/39381510068)
passed Version and four builds, but the `mac-x64` Dock visibility check failed: it waited only for
three concurrent Engine sessions to read idle, and `prompt` answers before the window applies the
turn's events, so on the slow runner one session was checked before its reply arrived. The check
now waits for each session to be idle with its reply and names the session, its last entry and the
unserved fake turns if one never arrives. The install jobs did not run in that dry run.

## Not verified

- The `v0.3.4` tag run, the draft and the published release.
- Visual review of the CI screenshots and the qualification, benchmark and provenance artifacts of
  the runs above; their counts are not recorded here. No benchmark comparison with 0.3.3 is made.
- An upgrade from the official 0.3.3 package (Engine 2 `.12`): the release upgrade gate stages 0.3.2
  (`.10`) as its baseline. Windows has no packaged upgrade gate.
- Paid-provider inference and completed external OAuth, including MCP server sign-in.
- Physical desktops, window managers and installer or AppImage lifecycles beyond the CI runners.
  macOS packages remain ad-hoc signed without notarization.
