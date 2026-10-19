# Vengeance 0.3.3

Vengeance 0.3.3 adds system prompt inspection and editing, protects more active work during engine
restarts, and makes opening saved conversations respond immediately. Syntax highlighting moves out
of the window's rendering thread. On macOS, background Engine and settings processes use Electron's
background helper so they do not create extra Dock applications.

**Release qualification is pending.** The historical Windows checks described below cover the
identified PR #15 builds. The final 0.3.3 candidate, including the macOS fix and expanded packaged
matrix, still needs its own CI and release dry-run results on all five platforms. These notes do
not describe those new gates as passed.

On 0.3.1 or 0.3.2, the Vengeance card in **Settings → Updates** offers the next published release.
The Windows installer and Linux AppImage can download and install updates; macOS and the deb, rpm,
pacman and tar.gz packages open the release page for a manual or package-manager update. On 0.3.0,
install the new package by hand, as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/docs/RELEASE-0.3.1.md)
explain. Settings, saved
sessions and sign-ins stay in place.

## Downloads

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.3.exe`               |
| macOS Apple silicon | `Vengeance-0.3.3-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.3-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Packages become available on the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases)
after qualification and publication. Requirements and first-launch steps remain in the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/README.md#install).
Verify downloads against `SHA256SUMS`, or use
`gh attestation verify <file> --repo LuciferMornens/vengeance` to check their build provenance.

## What's new

- **Inspect and edit system instructions.** Settings distinguishes the selected engine's native
  default foundation from the assembled prompt of an open conversation. The conversation view names
  its source and explains that it is a snapshot. Edit global or project `SYSTEM.md`,
  `APPEND_SYSTEM.md` and context instructions, customize the foundation, or restore inherited
  defaults. Draft protection and external-edit conflict checks prevent accidental replacement.
  Saving leaves open work running; applying saved instructions is an explicit guarded restart.
- **Safer restarts.** Active tools, streaming, children, observed side questions and session
  operations block a restart. Engine also refuses parked messages. Engine 2 preserves its native
  recovery queues during an otherwise idle restart, along with each resident's live provider, model
  and reasoning selection. Explicit changes apply only to the target, and recovery data remains
  available if the replacement fails.
  Deferred settings restarts retry temporary refusals and keep changes that arrive during restart.
  Instruction-file watches distinguish successful app writes from external edits.
- **Conversation opening gives immediate feedback.** Mouse and keyboard activation show progress
  while the engine loads history. The prior pane keeps its reading position if opening fails, and
  newer selections and deliberate focus changes take priority. History becomes usable before
  ancillary command and statistics reads finish. Cached tabs restore their scroll observers, and
  readers keep their anchor when a transcript crosses the virtualization threshold.
- **Lighter syntax highlighting and steadier scrolling.** A local worker compiles grammars and
  highlights code, with bounded caching and a plain-source fallback. Saved histories scroll upward
  correctly after reopening. Scrolling up during streamed growth pauses following, and real
  tool-collapse/streaming checks retain the existing follow budget and final bottom position.
- **Native command precedence survives reloads.** Command discovery tracks loading, success and
  failure. Extension reloads invalidate old results, combine duplicate reload requests and prevent
  stale responses from taking authority. Ambiguous slash-command drafts remain intact until the
  engine's command catalog is known.
- **No extra macOS Dock applications from background work.** Engine RPC, settings SDK/provider
  hosts, CLI commands and the login-shell environment probe use Electron's signed background
  helper. The main Vengeance window retains its normal Dock presence. A missing or invalid helper
  reports an error. Windows, Linux and explicit custom system Node selection keep their existing
  behavior; this fix does not change either native engine's patches.
- **Engine 2 append instructions reach the native prompt.** Build `0.10.0+vengeance.11` backports
  upstream's append-file assembly, including native prompt diagnostics. Engine remains
  `1.3.0+vengeance.2`. Both keep their pinned stable upstream bases; engine upgrades ship with the app.

## Windows navigation measurements

The historical PR #15 benchmark used Windows x64, Electron 44.7.0, three fresh processes per backend,
isolated accounts and two rich saved conversations. These figures identify a controlled comparison
from that report; they are not measurements of the new macOS fix or promises for other machines.

| Median measurement                 | Engine before | Engine after | Engine 2 before | Engine 2 after |
| ---------------------------------- | ------------: | -----------: | --------------: | -------------: |
| First conversation visible         |        825 ms |       491 ms |          877 ms |         901 ms |
| Second conversation, first visit   |        544 ms |       340 ms |          487 ms |         549 ms |
| First-visit renderer task blocking |        128 ms |         4 ms |          122 ms |          19 ms |

Highlighting no longer appears in the sampled renderer CPU profiles, and renderer blocking falls
substantially. Wall-clock results are mixed: Engine opens faster, Engine 2 takes longer in this
comparison, and cached returns cost about 20–25 ms more. A roughly 210 ms startup frame gap remains.
The baseline also failed upward-history scrolling; candidate samples passed the strict visibility,
syntax and scrolling checks. The
[performance report](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/docs/PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md)
contains exact source and artifact identities, endpoints, samples and scale results.

## Known limits

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/README.md#good-to-know)
still apply. macOS packages
are ad-hoc signed, without Developer ID signing or notarization, and cannot replace themselves
through the updater. Historical Windows qualification does not establish macOS or Linux behavior.
Live provider sign-in and paid-provider behavior were outside the PR #15 local qualification.

A synthetic scrolling diagnostic can still pause automatic following. It has not been reproduced
through a supported app action; the performance report retains the limitation and failed evidence.

## Qualification record

The [prompt and restart report](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/docs/ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md)
records the completed Windows native, packaged and restart checks, with exact build identities,
failed attempts and clean reruns. That evidence covers its identified builds; it does not qualify
later changes or other operating systems. Live sign-in and paid-provider behavior remain outside
that local qualification.

The final 0.3.3 candidate requires:

- **CI:** typecheck, build, workflow lint, contract checks and screenshot scenarios on Windows x64,
  macOS arm64 and Linux x64, with visual inspection of affected captures.
- **Packaged qualification on all five native platforms:** the release workflow builds both engines,
  helper and app, verifies payloads, update feed and platform runtime requirements, then runs the
  packaged, integration, model-isolation, system-prompts, restart-safety, stop-compaction, bash-queue,
  session-recovery and resident-close suites serially against the final QA app.
- **macOS arm64 and x64 background-process checks:** OS activation-policy observations, normal-mode
  login-shell probing, actual desktop PNGs and a red/green witness. The main app must remain a normal
  Dock application while background processes stay out of it.
- **First-navigation benchmark on all five platforms:** three fresh processes per backend against
  the completed built app, retaining JSON, CPU profiles, PNGs and source/native identities. This is
  separate from packaged QA and qualifies the current benchmark checks. It does not establish a
  speed improvement over an unmeasured macOS or Linux baseline.
- **Release artifacts:** macOS signature, zip and dmg verification; Linux glibc 2.35 checks and
  package-install checks; per-platform native/helper identities and release-file hashes, followed by
  `SHA256SUMS` and a provenance attestation for the published packages.

Final workflow run links, inspected desktop evidence and per-platform hashes must be recorded before
publication. The expanded matrix, macOS witness and new per-platform benchmark runs have not yet
been executed for this candidate.
