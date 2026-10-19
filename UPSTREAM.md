# Keeping Vengeance compatible with upstream

Vengeance follows pi and Prime Agent upstream. App performance and interface fixes belong in the app;
native patches remain small and reproducible. Vengeance owns its engine distributions, including
built-in extensions and native fixes, while deliberately tracking upstream stable releases.

## Current mechanisms and limits

| Component        | Current update behavior                                                                                      | Maintenance responsibility                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Engine (pi)      | Source-built CLI, SDK and built-in extensions shipped with Vengeance.                                        | Pin stable upstream, carry ordered patches, qualify SDK/RPC/bridge contracts.                  |
| Engine 2 (Prime) | Source-built native package shipped with Vengeance; residents run from a versioned app cache.                | Pin stable upstream, carry native fixes, qualify resident lifecycle and session compatibility. |
| Custom locations | Explicit development/testing overrides; no app-driven native self-update.                                    | Select a complete candidate package and record its exact hash.                                 |
| Prime helper     | Links the same patched native source as the bundled Engine 2; protocol/revision handshake remains mandatory. | Review all helper modes and qualify the helper with the patched engine.                        |

Engine updates are delivered only through Vengeance app releases. Native self-update commands and app
engine-update IPC reject attempts to replace these builds. Package updates and model catalog refreshes
remain native operations. There is no automatic patch rebase or scheduled upstream-maintenance job.

## Reconstructing and changing our builds

`engines.lock.json` is the source of truth. Current stable bases are pi `v1.3.0` at
`71023aec1546d6d677a65669c5665c0927ce0dd0` and Prime `v0.10.0` at
`763094e1b6a7c17450ee8399b06cda1853847ca5`. The builds identify as `1.3.0+vengeance.2` and
`0.10.0+vengeance.11`. Never reuse a Vengeance build version for different shipped behavior.

The current stable-release verification and Prime patch decisions are recorded in
[ENGINE-STABLE-AUDIT-2026-10-18.md](docs/ENGINE-STABLE-AUDIT-2026-10-18.md), with the preceding
source comparison in [PRIME-STABLE-AUDIT-2026-10-16.md](docs/PRIME-STABLE-AUDIT-2026-10-16.md).
The [pi patch guide](patches/pi/README.md) records the 1.3.0 reconciliation and retired catalog
fallback. The [14 October audit](docs/ENGINE-AUDIT-2026-10-14.md) records earlier integration
evidence and gaps. Engine 2 settings preservation and rustls maintenance are identified upstream
backports; its native base remains the latest stable release.

The [prompt and restart qualification report](docs/ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md) records
the current reconstructed artifacts and completed or pending gates. The
[navigation performance report](docs/PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md) keeps measured renderer
builds and native payloads explicit; its timings do not replace engine or packaged qualification.

[OpenAI native compaction](docs/openai-native-compaction.md) records the protocol study, checkpoint
compatibility policy and regressions for Prime patch `0015` and the Engine bridge. Requalify both
Responses transports, both authentication routes, cancellation and saved-session replay on upgrades.

pi's package version and extension-facing SDK `VERSION` stay at the upstream release, currently
`1.3.0`. Extensions can reject build suffixes even when all required APIs exist. The separate
`vengeance.version` metadata, native CLI `--version` and Vengeance engine descriptor report our build
identity. Native install-change detection uses that identity so a same-base patch upgrade is visible.
Qualify both forms through the native loader and repeat startup/restart with compatibility packages;
do not remove extensions or bypass their capability checks to make an engine build start.
`scripts/checks/bundled-engines.mjs` checks native identity, install-change detection and update guards.
`scripts/qa/ext/bundled-extensions.qa.mjs` checks the SDK/package contract, restart and saved history.
Set `QA_PI_PACKAGE_ROOT` to an installed pi agent directory to additionally copy OpenAI Codex compat,
Black and their dependencies into temporary QA storage. `QA_PACKAGED_EXE` repeats the same checks
against the packaged app; the source account and package files are never modified.

1. Run `npm run engines:prepare`. It creates ignored checkouts under `.engine-staging/source`, verifies
   the tag's exact commit, then applies the listed patches in order. It never resets an edited checkout.
   Clones use LF line endings on every host (`core.autocrlf=false`, `core.eol=lf`); an unedited checkout
   made before that rule is replaced, an edited one is refused.
2. Change native source or built-in extensions there. Export reviewed edits with `git diff --binary`
   (include new files with `git add -N <paths>`). Keep patches split by purpose and listed in application
   order. Regenerate a full baseline-relative series when rebasing; do not append an already-applied diff.
3. Update `engines.lock.json`, including the build version. `npm run build:engines` creates the new
   checkout, builds for the host platform, and fingerprints every shipped file. A changed checkout must
   be exported as patches first; an altered payload is rejected instead of silently trusted. A staged
   payload whose inputs and inventory still match is reused without a checkout or network; one staged
   for another platform is rebuilt. `-- --engine=pi` or `prime` builds just one backend. `npm run build`
   and `npm run dev` prepare both engines and the helper automatically.
4. Run the qualification matrix, then `npm run dist` (the host's packages: NSIS on Windows, dmg and zip
   on macOS, AppImage, deb, rpm and tar.gz on Linux, plus pacman on Linux x64) or
   `npm run dist:qa -- --dir`. The packaging hooks verify both payloads, their build inputs and their
   platform before copying anything, then verify the copy inside the package again.

Build hosts need Node 24.19.0 (`.node-version`) with npm 11, Git, Python 3 (`PYTHON` can select it) and
Rust/Cargo 1.98.1, which `rust-toolchain.toml` selects, with the host's Rust target from the lock:

- **Windows x64:** the `x86_64-pc-windows-gnu` host toolchain (make it rustup's default host before
  installing 1.98.1, so `rust-toolchain.toml` resolves to it), a MinGW-w64 `gcc` and GNU `objdump` on
  PATH (`OBJDUMP` can select it), and Git Bash as the development shell.
- **macOS arm64 and x64:** the Xcode Command Line Tools for clang, `codesign` and `otool`. The builders
  set `MACOSX_DEPLOYMENT_TARGET=13.0` and sign ad-hoc; no Apple Developer account is needed.
- **Linux x64 and arm64:** `build-essential`, binutils (`objdump`) and Python 3. Release builds run in
  an Ubuntu 22.04 container for the glibc 2.35 baseline. On a newer distribution the glibc check fails;
  build in that container, or set `VENGEANCE_GLIBC_BASELINE=host` for engines used only on that machine.
  Packaging also needs `rpmbuild` and `bsdtar` (`rpm` and `libarchive-tools` on Debian and Ubuntu).

Users need none of these to load the engines: pi uses Electron's Node; Prime includes its Python kernel
package, skills and catalogs. Native kernel provisioning and tools may still acquire their own language
environments/dependencies when first used. Package installation and developer tools keep their native
prerequisites, such as npm, Git or Bash; on macOS and Linux the app finds them through the login shell's
environment (SPEC §2.4).
`VENGEANCE_NATIVE_BUILD_JOBS=1` limits Engine 2 and helper build concurrency on smaller machines;
the default is four. Run native qualification and package builds serially when memory is limited.

pi uses upstream's locked build and runtime dependencies. Every internal runtime package is packed from
our checkout and substituted into the runtime lock before `npm ci --ignore-scripts`; none is resolved to
an upstream runtime binary. Model data comes from the content-addressed catalog pinned by that upstream
commit, followed by `build:offline`. The runtime installs with `--no-bin-links`: Vengeance runs the CLI
with Electron's Node, never through `node_modules/.bin` shims, which are links on POSIX. On macOS the
builder ad-hoc signs pi-tui's prebuilt darwin addons. Prime uses its Cargo lock, pinned catalog commit
and complete native release packer. Windows strips debug information after linking; Linux runs
upstream's split-debug step and gives the decoder to the packer, which never ships it; macOS keeps the
linked Mach-O and signs it. Every executable then passes its platform's runtime check (below).

The shipped manifest records the build platform, upstream revisions, patch hashes, build input
fingerprints, payload hashes, Engine 2's Rust target and entry, and toolchain/build metadata. Licenses
travel with each runtime. Build caches and compiled engines are ignored by Git; the lock, source patches,
builders, helper source and notices are committed.

Runtime cache folders are immutable per payload. Keep old Engine 2 caches while resident processes or
recovery references use them. App installers can replace their own resources without deleting those
residents' executable files. Validate transitions on isolated session copies before releasing an update.

## Platforms

Every platform builds natively on its own host; nothing is cross-compiled. `engines.lock.json` schema
version 2 maps each supported platform to its Rust target, and the builders target
`${process.platform}-${process.arch}`, refusing a host the lock does not list:

| Platform       | Rust target                 | Release runner                             | In `ci.yml` |
| -------------- | --------------------------- | ------------------------------------------ | ----------- |
| `win32-x64`    | `x86_64-pc-windows-gnu`     | `windows-2025`                             | Yes         |
| `darwin-arm64` | `aarch64-apple-darwin`      | `macos-15`                                 | Yes         |
| `darwin-x64`   | `x86_64-apple-darwin`       | `macos-15-intel`                           | No          |
| `linux-x64`    | `x86_64-unknown-linux-gnu`  | `ubuntu-24.04`, Ubuntu 22.04 container     | Yes         |
| `linux-arm64`  | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm`, Ubuntu 22.04 container | No          |

Engine 2's lock entry is `prime/prime-agent`; the staged manifest records the build host's `platform`,
the resolved `target` and the resolved `entry` (`prime/prime-agent.exe` on Windows). The packaging hooks
refuse a payload staged for another platform or architecture and verify the packaged copy in place
(`Contents/Resources/engines` on macOS). The helper follows the same rules and records its build in
`resources/prime-auth/bin/build.json`: fingerprint, executable SHA-256, platform, target, rustc and host.

Every shipped native executable passes `scripts/engines/native.mjs` before its hash is recorded:

| Format         | Runtime check                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PE (Windows)   | `objdump -p` imports name no GNU compiler runtime DLL (`libgcc`, `libstdc++`, `libwinpthread`).                                                                                                                                                                          |
| ELF (Linux)    | `NEEDED` names only the C runtime and loader (`libc`, `libm`, `libgcc_s`, `libpthread`, `libdl`, `librt`); `objdump -T` finds no symbol newer than `GLIBC_2.35`.                                                                                                         |
| Mach-O (macOS) | `otool -L` lists `/usr/lib/libSystem` and otherwise only `libc++`, `libobjc`, `libresolv`, `libz`, `libiconv` under `/usr/lib` and frameworks under `/System/Library/Frameworks`; every `LC_BUILD_VERSION` `minos` is at most 13.0; `codesign --verify --strict` passes. |

`VENGEANCE_GLIBC_BASELINE=host` skips only the glibc version check, for a local Linux build used on that
machine. Release builds never set it, and `scripts/ci/glibc-gate.mjs` checks the packaged app's ELF
files against 2.35 again. macOS signatures are ad-hoc (`codesign --sign -`), which carry no timestamp, so
signed bytes stay reproducible. Rewriting a signed Mach-O invalidates it, so only Windows strips after
linking. The engine builds sign Engine 2, the helper and every Mach-O file in pi's payload before
hashing; `electron-builder.yml` `signIgnore` keeps app signing away from those files, and the app's own
ad-hoc signature seals them as resources.

Reproducibility: checkouts are LF on every host, inventories sort names in code-unit order, independent
of the locale, and record the executable bit as `:x` on macOS and Linux, so a lost bit fails verification.
Payload hashes are per platform. npm keeps executable bits in pi's packed tarballs on POSIX, and the
shipped runtime lock records their checksums, so pi's payload differs from Windows even with identical
sources. Compare `inputHash` across platforms and payload hashes only between builds of the same
platform. A byte-identical native rebuild also needs the same host image, toolchain and absolute checkout
and Cargo home paths, since compiled-in source paths differ otherwise. Record the payload hashes from the
run that built the shipped packages.

### Qualifying macOS and Linux

GitHub Actions is the qualification path for macOS and Linux. `.github/workflows/ci.yml` runs on every
pull request and push to `main`. Its `engines` job builds both engines and the helper for `win32-x64`,
`darwin-arm64` and `linux-x64` (Linux in the Ubuntu 22.04 container) and caches the staged payloads under
a key of their inputs. Its `test` job restores exactly that key on the plain runner, verifies it through
`npm run build`, then runs `npm run checks` and `npm run shots` (Linux under Xvfb) and uploads the
screenshots. `.github/workflows/release.yml` runs as a dry run on pull requests that touch engines,
patches, the helper, packaging, toolchain pins or the workflow, and on manual dispatch. Each of the five
platforms then builds from a clean runner, packages, passes the baked-feed check, the GLIBC gate (Linux)
and signature, zip and dmg verification (macOS), and runs
`scripts/qa/engines/platform-qualification.mjs` against the QA app that
`node scripts/dist-qa.mjs --dir` prints. This runner executes nine suites serially against the packaged
application: packaged, integration, model isolation, system prompts, restart safety, Stop/compaction,
bash queues, saved-session recovery and resident closure. Each suite uses isolated accounts and local
providers; a smoke or version probe alone does not replace this matrix. The deb is install-tested on both Linux
architectures and the pacman package in an Arch container.

On macOS arm64 and x64, `scripts/qa/engines/background-apps.qa.mjs` additionally observes native
application activation policies while the packaged app exercises Engine RPC, SDK/provider hosts,
CLI commands, both engines and its normal-mode login-shell probe. It uses temporary accounts and
retains actual desktop PNGs, observed process identities and a red/green witness. The witness must
detect the previous main-executable child behavior before the corrected helper path can pass.
Inspect the desktop captures as well as the OS observations; page screenshots cannot prove that
background activity stays out of the Dock. The main Vengeance app must remain a regular application.

Each of the five release runners then runs
`node scripts/perf/first-navigation.mjs --label release-<platform> --runs 3` against the completed
built app. Upload the JSON, CPU profiles and PNGs from `.shots/perf/first-navigation`, including
source-bundle and native-payload hashes. This harness does not support `QA_PACKAGED_EXE`; its evidence
is separate from the packaged matrix. A passing current-candidate run does not establish an improvement
over an unmeasured platform baseline, and Windows before/after timings do not transfer to other hosts.

Treat those runs, their logs and uploaded screenshots as each platform's evidence and record them with
the platform's payload and package hashes. A Windows run never qualifies another platform. The native
workspace suites below and the transition and resident-upgrade suites are not part of CI; run them on a
host of the affected platform when a change touches platform-specific native behavior. Vengeance had no
macOS or Linux package before 0.3.0. Their executable-transition and resident-upgrade suites require
a retained package of the same platform; 0.3.0 is the earliest possible release baseline. Record the
actual baseline identity rather than substituting a Windows package or an unbuilt source revision.

### Electron's macOS background runtime

`src/main/electron-node.ts` centralizes Electron-as-Node executable selection. Windows and Linux use
`process.execPath`. On macOS, the pinned Electron 44.7.0 exposes an internal `process.helperExecPath`
property outside its public TypeScript declarations. The app validates that typed boundary and uses
the executable helper from the Electron bundle, whose signed `LSUIElement` identity keeps background
Node work out of the Dock. Missing, invalid or unavailable helper paths fail closed. Do not fall back
to the main app executable on macOS or hide the main app's Dock icon to compensate. Explicit custom
system Node locations keep their existing selection behavior.

This is an app runtime compatibility boundary, not a native engine patch. Requalify it whenever Electron
changes: verify the internal property and executable's availability, helper bundle identity and signature,
`LSUIElement` behavior, Engine RPC/SDK/provider/CLI operation, and the login-shell environment probe.
Repeat the packaged activation-policy and desktop-capture gate on both macOS architectures. Keep the
engine patch series unchanged for fixes that belong to this app-owned launch boundary.

## Adopting an upstream release

1. Record the upstream tag and full commit, app commit, platform, executable/package hashes, helper
   revision and patch list. Inspect release notes and the actual changed public APIs, settings, auth,
   daemon and session formats. Keep the currently working package available.
2. Stage the official candidate in an isolated directory with temporary account, session and kernel
   roots. Establish its behavior before adding local patches. Never test upgrades or migrations on the
   user's real account configuration or only copy of saved history.
3. Run the regression for each local native fix on that upstream baseline. Retire a patch when the
   baseline passes its regression and review confirms the native fix. Port only still-needed changes;
   conflicts require source review. Preserve meaningful red/green evidence and avoid counting fixture
   failures as product regressions. Keep source patches, license notices and exact base reconstructible.
4. Confirm that pi still ships the internal `dist/` files Vengeance imports by path. A moved or renamed file
   fails its operation with an error, it does not fall back. Main (`src/main/features/settings/pi-modules.ts`):
   `config.js`, `core/trust-manager.js`, `utils/paths.js`,
   `extensions/mcp/config.js`, `core/session-manager.js`, `core/model-runtime.js` and
   `core/settings-manager.js`. The SDK host (`src/main/engine/sdk-host/host.ts`): `core/model-runtime.js`,
   `core/settings-manager.js`, `core/package-manager.js`, `core/resource-loader.js`, `core/keybindings.js`
   and pi-ai's `dist/env-api-keys.js`. Native saved sharing also imports
   `core/saved-session-share.js`; live sharing uses its native RPC commands. Check the exports each
   one uses, not only that the file exists. Readiness must not refresh credentials or write account
   files. Destination consent must match the actual upload, and saved sharing must leave source
   bytes intact, including an unterminated final JSONL entry.
   `mcp list --json` in pi 1.2 reports `resources: true` as a capability, with resource listings fetched
   on demand. The app accepts that and numeric counts from older custom engines.
5. Review Vengeance's adapters and all Prime helper modes: OAuth, saved-session forks, resources, traces
   and restart capture/configuration. Follow `resources/prime-auth/README.md` when updating the helper's
   dependencies; both auth and restart revision consumers must agree. A helper handshake is not an
   engine/helper compatibility check. Test the supported engine/helper combinations explicitly.
   Restart requires helper capabilities `restartConfig`, `restartCapture` and `restartSelections`
   before native preparation. Once the daemon reaches `Prepared`, its mutation fence protects
   `get_connection_state` capture of every resident's provider, model and actual thinking level.
   The helper validates complete, unique roster/worker identities, paths and all descriptor/roster
   create envelopes before commit. It writes each captured selection to flat and nested create fields,
   then overlays explicit target configuration. Failed-successor recovery restores the raw backups,
   reapplies the checkpointed selections with an empty target patch and launches the prior engine.
   Keep those backups intact. Qualify changed target and idle-peer selections across providers, queued
   explicit overrides, malformed peer creates and failed-successor rollback through
   `scripts/checks/prime-restart-native.mjs`, `scripts/checks/prime-restart-isolation.mjs` and
   `scripts/checks/prime-adapter-real.mjs`.
   Prime can report `session_already_active` while a revived worker holds the file lease but its
   supervisor has not registered that identity. The app retries only the corresponding unknown-session
   attach, within a 30-second retry window, without creating another worker or changing the saved file. Qualify
   this boundary with `scripts/checks/prime-resident-identity.mjs` and repeated daemon-loss recovery.
   Prime streaming snapshots retain empty text and reasoning blocks at their native content indexes.
   OpenAI subscription responses can include reasoning without a visible summary before text or tool
   calls. The adapter must initialize those slots even without a nonempty delta; skipping them creates
   sparse renderer content and can crash the transcript. Qualify every intermediate frame through
   `scripts/checks/prime-streaming.check.ts` and the native subscription transport with
   `scripts/qa/engines/prime-streaming.qa.mjs`. The latter holds provider frames open to catch failures
   that a completed message would conceal. `scripts/shots/transcript-recovery.mjs` exercises the
   transcript error boundary, draft preservation and retry without restarting the engine.
   Image capabilities come from the selected native model's `input` modalities, not its name.
   Patch `0013` latches the resolved creation model into the native session's live selection.
   Global defaults choose new sessions; a sibling changing its default must not change an existing
   parent's metadata, reasoning, prompt, or provider request. Keep saved-session restore and explicit
   model changes working. Qualify real child completion, GPT 6.1 Sol / Max / Fast and restart with
   `scripts/qa/engines/model-isolation.qa.mjs`. Patch `0014` makes native preference/MCP writers merge
   only their changed fields into the locked document, preserving concurrent and unfamiliar keys.
   Engine 2 patch `0012` refreshes the generated prompt and kernel `model.info` when a resident or
   RPC session changes model. Qualify text-only → vision → text-only switches with
   `scripts/qa/engines/image-capabilities.qa.mjs`: GPT 6.1 Sol must resolve from the bundled catalog,
   `attach_image` must deliver an actual image block, and text-only models must still refuse it.
   Keep custom prompts and project instructions intact; do not rewrite their matching text.
   Native session-state model metadata must include input modalities, thinking levels and limits.
   Do not infer text-only support from an incomplete identity descriptor. The app resolves such a
   descriptor by exact provider and model ID from that resident's own catalog; it does not use the
   selected install's catalog. Failed verification stays unknown. An older resident can still have a
   stale native prompt and kernel binding, so the app reports running versus selected versions and
   offers an explicit guarded restart rather than pretending installation updated running work.
   Qualify mixed-version detach/reopen and app relaunch with
   `scripts/qa/engines/resident-upgrade.qa.mjs` and its reviewed baseline executable/hash inputs.
   Qualify saved Close tab versus explicit Stop with `scripts/qa/engines/resident-close.qa.mjs`.
   Keep idle residents discoverable in Background sessions; busy flags do not prove there are no
   saved goals or future schedules. Qualify masked model headers separately through the dual-engine
   integration suite.
   Response speed (Fast/Ultrafast) relies on these upstream contracts; re-check each one:
   - Engine 2: native `get_connection_state` with `includeServiceTierOptions: true` supplies the
     account-scoped `serviceTierOptions` model and tiers. The app renders that native offer;
     `set_service_tier`, `get_session_context.context.serviceTier`, and `service_tier_changed`
     carry the requested preference. Older resident binaries require an explicit session restart.
   - Engine 2 patch `0005`: upstream 0.10.0 drops `StreamOptions.service_tier` in both Responses
     providers' direct and simple stream constructors. Pass it through on API, HTTP and WebSocket
     routes. Native `Ultrafast` serialization must survive settings, session history and helper forks.
     The helper builder links the exact patched source, fingerprints its engine inputs, and uses a
     locked dependency graph; never rebuild the helper against an unpatched enum or session format.
   - Engine 2 resolves ChatGPT tier eligibility using its own native credential and model catalog.
     Cache scope includes endpoint and a token digest; failure can offer known Fast, never infer
     Ultrafast. Cancellation interrupts a pending catalog request. Account eligibility is enforced
     at the provider request boundary, while generic/API providers keep explicit tier passthrough.
     ChatGPT can echo `default` for a faster request: native billing follows the requested tier.
     An explicit provider tier refusal resets the preference to Standard and displays a notice;
     rate limits and unrelated provider errors do not change it.
   - Engine 2 restart configuration carries every resident's live provider, model and thinking level;
     explicit launch changes override only the target. Qualify model changes followed by restart,
     including idle peers and rollback, not only unchanged launch selections or tier serialization.
   - pi's own compaction summary request bypasses `before_provider_request`, so it runs at standard speed
     (a documented limitation); the bridge's native compaction checkpoint applies the speed itself.
   - ChatGPT model catalog (`resources/bridge/speed-mode-core.ts`): `GET <baseUrl>/codex/models?client_version=`
     `CODEX_CLIENT_VERSION` (`openai-codex`) or `GET <baseUrl>/models` (`openai`), headers `Authorization`,
     `chatgpt-account-id` (token claim) and `originator: codex_cli_rs`; `models[].slug`, `service_tiers[].id`
     (`priority`, `ultrafast`), legacy `additional_speed_tiers`.
   - pi (`resources/bridge/speed-mode.ts`): `before_provider_request` chains each handler's payload and treats
     `undefined` as unchanged; a `message_end` replacement is stored before persistence and RPC; the
     `provider_stream_event` shapes (Responses `response.*` with `service_tier`, Anthropic `message_start` /
     `message_delta` `usage.speed`); pi-ai's `calculateCost` through the loader's `@earendil-works/pi-ai` alias.
   - Anthropic: the `fast-mode-2026-02-01` beta and the fast-mode model list in `speed-mode-core.ts`.
   - Provider prices in `speed-mode-core.ts`: the per-model Fast/Ultrafast multipliers from OpenAI's pricing
     page (Fast and Ultrafast tables over Standard) and Claude fast mode's 2x. A model without a listed price
     shows none and keeps the cost the Engine computed.
6. Run the applicable matrix below on the final candidate. Build the full native package including
   runtime, skills and catalogs; verify imports, bootstrap, file hashes and the executable actually used
   by app workers. Do not substitute a development binary for the package delivered to the user.
7. Test the actual old-to-new executable transition and preservation of native identity, model/reasoning
   state and history. Retain the working package and recovery evidence until that succeeds, then promote
   only the passing candidate and record known limits. A previous binary alone is not a safe rollback
   plan if upstream migrated session data; validate recovery on isolated copies.

## Qualification matrix

Use the relevant public entrypoints and real staged engines with local fake providers. Keep assertions
about provider authentication separate from successful browser launch or cancellation. Complete live
sign-in testing only with explicit user authorization; report coverage gaps rather than calling it proven.

| Boundary                                                            | Existing regression entrypoints                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Both engines, configuration and account isolation                   | `scripts/qa/engines/integration.qa.mjs`, `scripts/qa/engines/updates.qa.mjs`, `scripts/qa/settings/engine-selection.qa.mjs`                                        |
| Model/reasoning changes and restart notices                         | `scripts/qa/engines/restart-notices.qa.mjs`, `scripts/qa/engines/candidate-controls.qa.mjs`                                                                        |
| Active-work restart refusal and deferred restart admission          | `scripts/checks/engine-restart.check.ts`, `scripts/qa/engines/restart-safety.qa.mjs`                                                                               |
| Native prompt inspection, scoped edits and explicit application     | `scripts/qa/settings/system-prompts.qa.mjs`, `scripts/shots/system-prompts.mjs`; helper `system_prompt` tests                                                      |
| Parent/child model isolation and concurrent settings preservation   | `scripts/qa/engines/model-isolation.qa.mjs`; native `model_isolation`, settings persistence and `settings_mcp_save` regressions                                    |
| Image capabilities, live model switches and tool/image delivery     | `scripts/qa/engines/image-capabilities.qa.mjs`; native model-switch and prompt regressions                                                                         |
| Response speed, subscription entitlement and native tier transport  | `scripts/qa/engines/speed-mode-engine2.qa.mjs`, `speed-mode.qa.mjs`, `speed-mode-subscriptions.qa.mjs`; native `service_tiers` and `service_tiers_transport` tests |
| Stop, compaction transport cancellation, shell context and queues   | `scripts/qa/engines/stop-compaction.qa.mjs`, `scripts/qa/engines/bash-queue.qa.mjs`, native regressions retained in `patches/prime-agent`                          |
| Old history, cross-workspace recovery and executable transition     | `scripts/qa/engines/session-recovery.qa.mjs`, `scripts/qa/engines/candidate-transition.qa.mjs`                                                                     |
| Mixed-version resident attachment and Close tab versus Stop session | `scripts/qa/engines/resident-upgrade.qa.mjs`, `scripts/qa/engines/resident-close.qa.mjs`; selected-state and transport regressions                                 |
| Packaged app, external bridge and native helper                     | `scripts/qa/engines/packaged.qa.mjs`, `scripts/checks/prime-auth-native.mjs`, `scripts/checks/prime-auth-oauth.mjs`                                                |
| Packaged native-engine matrix on all five platforms                 | `scripts/qa/engines/platform-qualification.mjs`; nine serial suites against the final packaged QA app                                                              |
| macOS background application identity and Dock behavior             | `scripts/qa/engines/background-apps.qa.mjs`; OS activation policies, normal-mode shell probe, desktop PNGs and red/green witness on arm64 and x64                  |
| Scale and lifecycle retention when those contracts change           | `scripts/qa/performance/session-listing.qa.mjs`, `scripts/qa/performance/session-churn.qa.mjs`, `scripts/qa/performance/long-tools.qa.mjs`                         |
| Process-cold launch and first conversation navigation               | `scripts/perf/first-navigation.mjs`; both native engines, rich saved histories, frame gaps, CPU profiles and rendered syntax verification                          |
| Engine 2 native long-history activation and retention               | `scripts/qa/performance/prime-long-history.qa.mjs`; public native writer, cold/resident opening, cached workspace switching and frame/heap bounds                  |
| Mixed-engine workspace scale and hidden-workspace navigation        | `scripts/qa/performance/workspace-scale.qa.mjs`; full 8,300-history, 65-workspace corpus                                                                           |
| Engine stable upgrade and recovery on an isolated copy              | `scripts/qa/engines/pi-transition.qa.mjs`; retain a complete baseline package with `QA_PI_BASELINE_PACKAGE`                                                        |
| Engine 2 family identity, child history and deletion                | `scripts/qa/engines/subagent-lineage.qa.mjs`, `scripts/checks/prime-resident-identity.mjs`; native/helper lineage and deletion tests                               |

The candidate fixture accepts an absolute `QA_PRIME_EXECUTABLE` and requires its exact
`QA_PRIME_SHA256`. For executable transitions, set `QA_PRIME_BASELINE_EXECUTABLE` to a retained,
complete package and record its hash. The legacy default `.engine-staging/prime/release` is only a
fallback slot; `engines:prepare` does not populate it. The separate historical resident-upgrade suite
also requires `QA_PRIME_BASELINE_SHA256`. The harnesses prove the configured pair, not every future
version combination. Follow [scripts/qa/README.md](scripts/qa/README.md) for isolation and report setup.

When app/helper source changes, run `npm run typecheck`, `npm run build`, `npm run checks` and
`npm run shots`, and inspect the images. Run native regressions, formatting and clippy for changed Rust
code. Record commands, final results and exact artifact identities. Expand coverage for changed upstream
contracts; a passing historical test count is not a substitute for that review.

Cross-engine handoff uses each destination's native session writer. Requalify
`scripts/checks/engine-handoff.check.ts`, `scripts/checks/engine-switch.check.ts` and
`scripts/qa/engines/engine-switch.qa.mjs` when either session format changes. The active branch must
include pre-compaction history, remapped retained-entry anchors, tool results, images and context
edits. Prime custom-message timestamps are ISO strings in `get_messages`; normalize them
deterministically before comparing snapshots. Native resident summaries, input-pause leases and
side-question tracking must still prevent stopping active work. Imported assistant metadata must not
replace the destination's own default model. Runtime goals, schedules, kernel state and credentials
are outside the history transfer; source files remain recovery copies.

Qualify the reconstructed native workspaces as well:

```sh
node scripts/checks/pi-workspace.mjs check
node scripts/checks/pi-workspace.mjs
node scripts/checks/pi-changelog.mjs   # requires a terminal
node scripts/checks/prime-workspace.mjs --with-kernel
```

These runners use temporary homes, configuration, session and kernel directories, remove inherited
credentials, and verify both real account configurations after each native command. pi's full suite
uses upstream `./test.sh`, including its filesystem-retention passes. Credential-dependent live API
tests and external SSH fixtures remain explicitly reported as skipped. Prime runs the full Cargo
workspace, formatting and clippy. `--with-kernel` builds the native CLI and bootstraps a temporary
Python environment for the packaged-kernel tests; it never uses the account's kernel installation.
Before the full pi suite or a targeted `env` run, its runner builds the locked Env daemon, matching
[upstream CI](https://github.com/earendil-works/pi/blob/v1.3.0/.github/workflows/ci.yml).
`QA_NATIVE_JOBS` bounds this Rust prerequisite to 1–32 jobs (default four). Env supports Windows
file and command operations; its standalone package is outside the coding-agent SDK's runtime
dependency graph. The test prerequisite does not add a daemon to Vengeance's payload.
Git Bash utilities and a Python interpreter are native test prerequisites on Windows; on macOS and
Linux the pi runner uses the system `bash`.
`QA_PI_SOURCE` and `QA_PRIME_SOURCE` select an authoring checkout while
developing a patch; release qualification must also reconstruct and build the exported patch series.

On Windows, cargo-fmt's single invocation can exceed the command-line limit after canonicalizing all
workspace targets. The Prime runner checks each metadata-discovered package and recursively declared
path dependency separately, with the same formatter and checks; it reports package and target counts.
For native qualification on a memory-limited host, omit debug symbols and bound test concurrency:

```sh
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 RUST_TEST_THREADS=4 \
  node scripts/checks/prime-workspace.mjs --with-kernel
```

These settings change symbol output and scheduling, not assertions or runtime lock budgets. Record
them with the run. Debug executables can be large enough to make the packaging fixture's archive and
checksum work costly. A run requiring external process cleanup is diagnostic evidence; repeat it
without intervention before reporting a clean native pass.

Retain the Windows regressions for session cache invalidation, file leases, named-pipe cancellation,
fragmented daemon commands interrupted by events, npm launching and edit errors. A fragmented command
must keep its prefix when another event wins the daemon's select loop; test the actual socket protocol,
including the reply's command ID. Do not replace these checks with longer timeouts.

Retired pi patch `0004` qualified model data missing or stale in the former upstream catalog.
The pinned 1.3.0 catalog supplies the qualified Claude Haiku/Sonnet 5.5 data, including Haiku Off
thinking and Sonnet cache pricing. `scripts/checks/pi-catalog.mjs` checks the staged native models.
Recheck reasoning, vision limits and pricing against the next upstream catalog and the provider's
documentation; never regenerate or hand-edit the pinned catalog merely to satisfy a test.

pi patch `0006` adds Abliteration's three models as a native provider, including API-key login,
`ABLIT_KEY` discovery, per-session cache affinity, model-specific thinking levels and vision metadata.
Large V2 exposes every accepted effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), with
no Off control because reasoning cannot be disabled. The provider maps those aliases to low/high/max.
Recheck [models](https://docs.abliteration.ai/models), [pricing](https://docs.abliteration.ai/pricing),
[thinking](https://docs.abliteration.ai/capabilities/thinking) and the
[Engine integration](https://docs.abliteration.ai/integrations/pi) on upgrades. The integration example's
prices can lag the pricing page. Retire the patch when upstream supplies qualified support.
Run `scripts/qa/auth/abliteration.qa.mjs` for isolated login, catalog, reasoning, image and tool transport
coverage. Live verification is opt-in with `VENGEANCE_LIVE_ABLITERATION_QA=1` and `ABLIT_KEY`.

Qualified on 16 October 2026 against the reconstructed and staged Engine `1.2.0+vengeance.4`.
The staged pi payload hash is
`c1982922b32b4e5c5de87d2e866b5ab558d1a92d766573f1a69e3cd6eb7c0ca9`;
patch `0006` has SHA-256 `5e330f77421ad2cf5aa570a356108c2e61d813bfc7aeeb1bdf3cc4bb6c865cce`.
Both engines passed bundled identity, system-PATH startup and native update-guard checks.
Native workspace checks verified both real account configurations remained unchanged. Live API tests
used temporary accounts and bounded output: all three models completed native read-tool continuations,
and Large V2 completed each of its six efforts. Base-model image transport was tested with the local
provider; live image understanding was not exercised.

```text
npm run build
  ✓ built in 21.36s
npm exec --yes --package=prettier -- prettier --check README.md UPSTREAM.md engines.lock.json patches/pi/README.md scripts/qa/auth/abliteration.qa.mjs scripts/shots/abliteration.mjs
  All matched files use Prettier code style!
node scripts/checks/pi-workspace.mjs check
  ✓ isolated native Engine checks passed
npm run checks
  ✓ all checks passed
node scripts/checks/pi-workspace.mjs ai test/abliteration.test.ts test/providers.test.ts test/openai-completions-prompt-cache.test.ts test/openai-completions-empty-tools.test.ts
  Tests  60 passed (60)
node scripts/qa/auth/abliteration.qa.mjs
  ✓ auth-abliteration passed (20.5s)
VENGEANCE_LIVE_ABLITERATION_QA=1 node scripts/qa/auth/abliteration.qa.mjs
  ✓ auth-abliteration-live passed (32.1s)
```

Feature screenshots are `.shots/abliteration-provider.png`, `.shots/abliteration-sign-in.png` and
`.shots/qa/abliteration-shots/abliteration-03-large-v2-efforts.png` (all visually inspected).
`npm run typecheck` passed for main and renderer. The full `npm run shots` attempt had one timeout
waiting for the Engine 2 close-tab tooltip; `npm run shots -- session-close` then passed all five
screenshots in isolation, without code changes. Other scenario files completed. The transcript-recovery
scenario's logged null/trim error is its intentional malformed-frame fixture, asserted by that scenario.

For Vengeance 0.3.0 (17 October 2026) the Windows x64 payloads were rebuilt with the cross-platform
builders. Upstream bases and the native patch series are unchanged apart from pi's test-only patch
`0008`; both build versions moved because the shipped Windows bytes changed. Engine `1.3.0+vengeance.2`
drops the 24 `node_modules/.bin` shims (otherwise only its build-version metadata changed). Engine 2
`0.10.0+vengeance.10` builds from an LF checkout, so its text files and compiled-in prompts no longer
follow the builder's Git line-ending setting. The staged `win32-x64` payload hashes are pi
`97f796c58c176d6f78f1bbb45564c26225d53826bcb34b479865900002d18a39` and Prime
`b743f51df4f9ab40c1b697539d6765cd88a19da1aaf8df3e7ee28b122c321768`; the helper's SHA-256 is
`b458090ec4220d2ebc99df10bc8700c04a750017aea2d2ab335fb7422ca539d3`. The macOS and Linux payloads are
built by the release workflow; record their hashes from that run.

If a fix belongs upstream, retain a minimal reproducer and a reviewable patch suitable for contribution.
Publishing issues or pull requests remains a separate authorized action. Once a supported upstream
release incorporates the behavior, prefer it and remove the local patch after qualification.

Engine 2 `0.10.0+vengeance.11` backports native append-file assembly from upstream commit
`b1d71636710b0ea1b86380dfe3923b3c03fe2948` in patch `0020`. The stable base discovers
`APPEND_SYSTEM.md` but omits it from resident prompts. The patch passes discovered or explicit append
sources through the native prompt builder, preserving raw Markdown, independent SYSTEM/APPEND scope
precedence, and explicit-source overrides. The native `prompt` diagnostic now includes the same append
text. The stable builder's direct guideline API remains available. Retire the backport once a stable
base contains the upstream fix and the provider-payload and diagnostic regressions pass on that base.
No session format, account schema, or helper protocol revision changes. Rebuild the helper against the
new engine fingerprint, and qualify an idle resident transition from the complete `.10` package.

The `.11` lock now carries 22 ordered Prime patches. Patches `0021` and `0022` are test-only
qualification changes after runtime backport `0020`; the upstream base and protocol revisions remain
pinned. The first native attempt exposed both a Windows ACP cleanup hang and refinement-fixture lock
starvation. Its ACP EOF assertion had passed before a stderr-reader join stalled; stopping that
identified temporary daemon released the reader, so the intervened run is not a clean qualification.
Patch `0021` uses anonymous-file diagnostics and bounded, acknowledged native shutdown. Keep its
session creation/EOF assertions and verify the fixture leaves no native processes. Retire it after the
equivalent upstream fixture passes repeated Windows runs and the full native suite without cleanup
intervention.

Patch `0022` takes only the refinement fixture from upstream
[`f0d9c09676a1e6bb2782ad73eb3025ffdf2061d4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/f0d9c09676a1e6bb2782ad73eb3025ffdf2061d4).
Five isolated stable-fixture failures confirmed repeated reacquisition can exhaust the intentional
bounded lock wait. The correction races two fresh writers per round, retaining the 80-update check;
it changes no runtime lock or timeout and excludes the unrelated abort-test change. Retire it when
the stable candidate includes that hunk and passes repeated isolated and full-workspace checks.
The reconstructed 22-patch series completed 4,477 passing tests and 14 ignored tests across 216
suites, with all nine packages and 211 formatting targets checked. The subsequent Clippy finding
required only an equivalent branch inversion in `0020`'s append fixture. After re-export and fresh
reconstruction, all eight append cases and full-workspace, all-target Clippy with `-D warnings` pass;
both real-account guards pass. The complete test log precedes that assertion-preserving style edit.
Final engine/helper rebuilds, app integration and packaged qualification remain separate gates.
Record those results and per-platform artifact identities with the release evidence.
