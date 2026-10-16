# Engine 2 image capabilities

> Historical fix and qualification record for app 0.2.6 / Engine 2 `0.10.0+vengeance.4`.
> Versions, hashes and local evidence below describe that build. The fix remains in the current
> patch series; see [engines.lock.json](../engines.lock.json) and [current guides](../README.md).

Engine 2's image support is determined by the selected native model's `input` modalities.
GPT 6.1 Sol is image-capable in the pinned native catalog. Models whose input is text-only remain
text-only. Custom model definitions and explicit input overrides keep their native precedence.

## Reproduced defects

The real `0.10.0+vengeance.3` package reproduced the false warning and refusal using temporary
accounts and local fake providers:

- Resident session-state metadata omitted input modalities. The app displayed text-only support,
  even for a new GPT 6.1 Sol session.
- Live model switches did not refresh the generated image-capability prompt.
- Resident model switches did not refresh kernel `model.info`, so `attach_image` still checked
  the model the session started with.

The regression uses GPT 6.1 Sol from the real bundled catalog. Only the provider URL and isolated
credentials are configured; the test does not declare image support for that model. It checks
both switch directions, actual pasted-image and tool-image bytes, text-only refusals and startup.

## Native fix

Patch `0012-live-model-image-capabilities.patch` updates resident and RPC model switches through
one native selection method. Model, reasoning level and generated prompt update together in the
agent state. Kernel facts and the prompt read/export surfaces follow the selection. Structured
prompt segments keep user instructions intact, even when they quote the same capability text.
Native session-state metadata includes modalities, thinking levels, cost and token limits, without
headers or arbitrary compatibility data. No catalog capability values or image-size limits change.
The new QA uses named 24 × 24 pixel PNG fixtures, a one-day fake-token lifetime and a two-minute
kernel-turn allowance. These are isolated test values, not production defaults.

Engine 2 advances to `0.10.0+vengeance.4`; its upstream base and catalog pin stay unchanged.
The first engine stays `1.2.0+vengeance.3`. The app version stays `0.2.6`.

Per-turn `imageModel` routing and provider failover are separate native contracts and are not changed
by this session-selection fix. No live provider inference or sign-in is used for qualification.
The user's installed application and running resident sessions are not replaced during development.

## Validation

The old package has **7 passing and 7 failing** public image-capability checks. The corrected PNG
fixture verifies that fresh vision startup already delivered tool image bytes in the old package;
its public model descriptor still incorrectly reported text-only. The apparent startup transport
failure was fixture serialization, not another native defect.

Focused native results on the authoring checkout:

| Command tail for `node scripts/checks/prime-workspace.mjs`                                           | Final result                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `test -p pa-core --lib live_model_selection_updates_the_prompt_and_image_skill_facts -- --nocapture` | `1 passed; 0 failed`                        |
| `test -p pa-daemon --test model_capabilities -- --nocapture`                                         | `1 passed; 0 failed`                        |
| `test -p pa-agent --lib -- --nocapture`                                                              | `15 passed; 0 failed`                       |
| `test -p pa-core --lib session_engine::engine::tests -- --nocapture`                                 | `4 passed; 0 failed`                        |
| `test -p pa-core --lib prompts::system_prompt::tests -- --nocapture`                                 | `5 passed; 0 failed`                        |
| `test -p pa-core --test golden_system_prompt -- --nocapture`                                         | `1 passed; 0 failed`                        |
| `fmt --all --check`                                                                                  | `✓ isolated native workspace checks passed` |
| `clippy --workspace --all-targets -- -D warnings`                                                    | `✓ isolated native workspace checks passed` |

Every native runner also reports `✓ both real account configurations remained unchanged`.
Clippy has only the pinned vendored crossterm warnings, not project warnings. Native error and
shutdown behavior stays unchanged: model-change persistence remains best-effort on both transports.

The exported patch series reconstructs a clean checkout at
`.engine-staging/source/prime-763094e1-e088ec0c`. All ten modified files match the tested authoring
checkout after normalizing checkout line endings. Release build and full native qualification use
this reconstructed source, not edited staging binaries.

### Application and public transport results

| Command                                                        | Final output                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `npm run typecheck`                                            | exit 0, both TypeScript targets                            |
| `npm run checks`                                               | `✓ all checks passed`                                      |
| `npm run build:engines`                                        | `prime: staged 0.10.0+vengeance.4 (61 files)`              |
| `npm run build`                                                | `✓ built in 21.31s`                                        |
| `npm run shots`                                                | `Screenshots in D:\Coding\vengeance\.shots`                |
| `npx prettier --check` on owned lock, QA scripts and documents | `All matched files use Prettier code style!`               |
| `node scripts/qa/engines/image-capabilities.qa.mjs`            | `✓ Native image capability: 14 checks passed`              |
| `node scripts/qa/engines/integration.qa.mjs`                   | `✓ engines-integration passed`                             |
| `node scripts/qa/engines/restart-notices.qa.mjs`               | `✓ regression: 31 checks, 0 observed regressions`          |
| `node scripts/qa/engines/candidate-controls.qa.mjs`            | `✓ Native candidate controls and restart: 4 checks passed` |
| `node scripts/qa/engines/session-recovery.qa.mjs`              | `✓ native historical session recovery passed`              |
| `node scripts/checks/pi-workspace.mjs check`                   | `✓ isolated native Engine checks passed`                   |
| `node scripts/checks/pi-workspace.mjs`                         | `✓ isolated native Engine checks passed`                   |

Public real-engine suites use the rebuilt `.4` executable and its required exact SHA-256 through
`QA_PRIME_EXECUTABLE` and `QA_PRIME_SHA256`, with temporary account storage and local providers.
The image suite passed all 14 checks, including both switch directions, startup, actual image bytes
and proper text-only refusal. All six image PNGs were viewed; Sol has the Images indicator and no
unsupported warning, while the text-only selection retains the warning. Full dual-engine integration
also verifies that literal native authorization headers stay out of renderer IPC responses.

The unchanged pi workspace needed its documented `packages/env` native daemon prerequisite. After
an isolated `cargo build --manifest-path daemon/Cargo.toml --locked`, its full suite passed. That
build and suite did not edit pi source. Credential-dependent providers, SSH fixtures and upstream
Windows terminal skips are not claimed as covered. The pi changelog terminal fixture was not rerun
because pi source and version did not change.

The unchanged `.3` → `.4` transition suite passed its serial rerun:
`node scripts/qa/engines/candidate-transition.qa.mjs` →
`✓ Official-to-candidate native restart: 3 checks passed`. It verifies both executable hashes,
worker/daemon replacement, unchanged session identity/history/reasoning, restored catalog capabilities
and a follow-up provider response. The first parallel run failed its broad candidate-identity guard
without saving the rejected process identity; that cause is unproven. No assertion was weakened to
obtain the serial result. Both runs are retained in the local evidence directory.

### Full reconstructed native qualification

`node scripts/checks/prime-workspace.mjs --with-kernel` completed on the reconstructed exported
source with **4,451 passed, 0 failed, 14 ignored** across the workspace and doc-test result rows.
The runner built and bootstrapped its own temporary Python kernel, then completed workspace
formatting, tests and `clippy --workspace --all-targets -- -D warnings`:

```text
Finished `dev` profile [unoptimized + debuginfo] target(s) in 51.58s
✓ isolated native workspace checks passed
✓ both real account configurations remained unchanged
```

The first broad run under parallel build/QA load failed the unrelated
`refinement::tests::concurrent_update_harness_state_writes_all_land` on its native lock-acquisition
limit. The complete repeat passed without changing source, tests, retry counts or timeouts. Both
logs remain available as `native-workspace-first.log` and `native-workspace.log`. No assertion is
skipped or weakened for the repeat. Inherited vendored crossterm warnings and declared ignored
external/bootstrap fixtures remain explicitly out of scope for a clean-project-warning claim.

Final real configuration content hashes and auth-file modification timestamps match the original
snapshots. No user installation, sign-in or running-session restart was performed. To use the fix,
run the rebuilt application and start or restart its Engine 2 session.

The final source sweep found no new long lines, stubs, debug output or unused imports. New source
and QA files remain below 800 lines. Large upstream ownership files receive surgical edits rather
than unrelated module restructuring. The new transition baseline option changes only the QA
harness; selected-model identity/history checks remain, and restored metadata is compared against
the native catalog instead of an old descriptor that omitted capabilities.

### Artifact identity

| Artifact                                         | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Patch `0012-live-model-image-capabilities.patch` | `f1741ebf0c50305ed6dd8e03467971f034b5c5ac72b8bac6d21a4357d32a3328` |
| Ordered native patch-series input                | `e088ec0c3cffc3fb6e87fae06bf0e25003d2cf7f9b448c119390720f350839dd` |
| Old `0.10.0+vengeance.3` executable              | `203b2f8c7e07cdc9f67199f65694be8f9f97f87daebcd8967d6cc789d2864c49` |
| New `0.10.0+vengeance.4` executable              | `4b1eca49b69bda05ef6afdf0f7d3d3ba8aea1497bd32cb18219af4927cd02770` |
| New `0.10.0+vengeance.4` payload                 | `b369869a0789cc9270f45eee41485f3aca28fbce9e8f11bd875b92f80192217b` |

The old package is retained at `.engine-staging/qualified/prime-0.10.0-vengeance.3` for the
executable-transition regression. Local command logs and the corrected red public report are under
`.cache/prime-auth/vision-validation`. UI screenshots are under `.shots`; the full screenshot gate
passed and representative images were viewed directly.
