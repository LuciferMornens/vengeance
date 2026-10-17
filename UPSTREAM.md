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
`763094e1b6a7c17450ee8399b06cda1853847ca5`. The builds identify as `1.3.0+vengeance.1` and
`0.10.0+vengeance.9`. Never reuse a Vengeance build version for different shipped behavior.

The current Prime source comparison and patch decisions are recorded in
[PRIME-STABLE-AUDIT-2026-10-16.md](docs/PRIME-STABLE-AUDIT-2026-10-16.md).
The [pi patch guide](patches/pi/README.md) records the 1.3.0 reconciliation and retired catalog
fallback. The [14 October audit](docs/ENGINE-AUDIT-2026-10-14.md) records earlier integration
evidence and gaps. Engine 2 settings preservation and rustls maintenance are identified upstream
backports; its native base remains the latest stable release.

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
2. Change native source or built-in extensions there. Export reviewed edits with `git diff --binary`
   (include new files with `git add -N <paths>`). Keep patches split by purpose and listed in application
   order. Regenerate a full baseline-relative series when rebasing; do not append an already-applied diff.
3. Update `engines.lock.json`, including the build version. `npm run build:engines` creates the new
   checkout, builds, and fingerprints every shipped file. A changed checkout must be exported as patches
   first; an altered payload is rejected instead of silently trusted. `-- --engine=pi` or `prime` builds
   just one backend. `npm run build` and `npm run dev` prepare both engines and the helper automatically.
4. Run the qualification matrix, then `npm run dist` (NSIS) or `npm run dist:qa -- --dir`.
   The packaging hook verifies both payloads and their build inputs before copying anything.

Build hosts need Node/npm, Git, Python, Rust/Cargo 1.98.1 for `x86_64-pc-windows-gnu`, and GNU `objdump`
on PATH (`OBJDUMP` can select it). Users need none of these to load the engines: pi uses Electron's Node;
Prime includes its Python kernel package, skills and catalogs. Native kernel provisioning and tools may
still acquire their own language environments/dependencies when first used.
Package installation and developer tools keep their native prerequisites, such as npm, Git or Bash.
`VENGEANCE_NATIVE_BUILD_JOBS=1` limits Engine 2 and helper build concurrency on smaller machines;
the default is four. Run native qualification and package builds serially when memory is limited.

pi uses upstream's locked build and runtime dependencies. Every internal runtime package is packed from
our checkout and substituted into the runtime lock before `npm ci --ignore-scripts`; none is resolved to
an upstream runtime binary. Model data comes from the content-addressed catalog pinned by that upstream
commit, followed by `build:offline`. Prime uses its Cargo lock, pinned catalog commit and complete native
release packer. The binary is stripped and checked for external GNU runtime DLL imports.

The shipped manifest records upstream revisions, patch hashes, build input fingerprints, payload hashes,
and toolchain/build metadata. Licenses travel with each runtime. Build caches and compiled engines are
ignored by Git; the lock, source patches, builders, helper source and notices are committed.

Runtime cache folders are immutable per payload. Keep old Engine 2 caches while resident processes or
recovery references use them. App installers can replace their own resources without deleting those
residents' executable files. Validate transitions on isolated session copies before releasing an update.

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
   - Engine 2 restart configuration carries the live model and thinking level unless launch options
     explicitly change them. Qualify model changes followed by restart, not only unchanged launch
     selections or tier serialization.
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
| Parent/child model isolation and concurrent settings preservation   | `scripts/qa/engines/model-isolation.qa.mjs`; native `model_isolation`, settings persistence and `settings_mcp_save` regressions                                    |
| Image capabilities, live model switches and tool/image delivery     | `scripts/qa/engines/image-capabilities.qa.mjs`; native model-switch and prompt regressions                                                                         |
| Response speed, subscription entitlement and native tier transport  | `scripts/qa/engines/speed-mode-engine2.qa.mjs`, `speed-mode.qa.mjs`, `speed-mode-subscriptions.qa.mjs`; native `service_tiers` and `service_tiers_transport` tests |
| Stop, compaction transport cancellation, shell context and queues   | `scripts/qa/engines/stop-compaction.qa.mjs`, `scripts/qa/engines/bash-queue.qa.mjs`, native regressions retained in `patches/prime-agent`                          |
| Old history, cross-workspace recovery and executable transition     | `scripts/qa/engines/session-recovery.qa.mjs`, `scripts/qa/engines/candidate-transition.qa.mjs`                                                                     |
| Mixed-version resident attachment and Close tab versus Stop session | `scripts/qa/engines/resident-upgrade.qa.mjs`, `scripts/qa/engines/resident-close.qa.mjs`; selected-state and transport regressions                                 |
| Packaged app, external bridge and native helper                     | `scripts/qa/engines/packaged.qa.mjs`, `scripts/checks/prime-auth-native.mjs`, `scripts/checks/prime-auth-oauth.mjs`                                                |
| Scale and lifecycle retention when those contracts change           | `scripts/qa/performance/session-listing.qa.mjs`, `scripts/qa/performance/session-churn.qa.mjs`, `scripts/qa/performance/long-tools.qa.mjs`                         |
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
Git Bash utilities and a Python interpreter are native test prerequisites on Windows.
`QA_PI_SOURCE` and `QA_PRIME_SOURCE` select an authoring checkout while
developing a patch; release qualification must also reconstruct and build the exported patch series.

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

If a fix belongs upstream, retain a minimal reproducer and a reviewable patch suitable for contribution.
Publishing issues or pull requests remains a separate authorized action. Once a supported upstream
release incorporates the behavior, prefer it and remove the local patch after qualification.
