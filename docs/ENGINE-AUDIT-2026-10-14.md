# Engine audit — 14 October 2026

> Qualification checkpoint before the app version bump to 0.2.7. Upstream heads, native builds,
> test results and artifact hashes below record this audit; the installer here was built as 0.2.6.
> See [current guides](../README.md) and [engines.lock.json](../engines.lock.json) for the maintained build.

## Result and source selection

Engine remains `1.2.0+vengeance.3` on pi `v1.2.0`, revision
`06a466935536f8c9bcacb2d5efc0fc021be1bdff`. Engine 2 becomes
`0.10.0+vengeance.5` on Prime `v0.10.0`, revision
`763094e1b6a7c17450ee8399b06cda1853847ca5`. Both are source builds reconstructed from
[engines.lock.json](../engines.lock.json). All five existing Engine patches and all twelve existing
Engine 2 patches remain in order. The helper links the same patched Prime source.

Remote tags and source were checked against the official repositories. Neither engine has a newer
stable release at this checkpoint. Prime has `v0.10.1-beta.22`; that is a prerelease, not a qualified
stable replacement. The reviewed development heads are:

| Repository                                                      | Reviewed head                              | Commits after the stable base |
| --------------------------------------------------------------- | ------------------------------------------ | ----------------------------: |
| [pi](https://github.com/earendil-works/pi)                      | `b45e0ebcc5ae2fc42a6f2f23104d10e656e6bedb` |                            44 |
| [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | `33da15a2c15c4e903c372f69ae8e1156d77d53da` |                            61 |

Prime's model catalog pin `b90e08807c37ccdfab04eb31b23de6a86dd6e7fe` also matches the
checked catalog head. Preparing local engine checkouts alone does not update packaged engines:
only patches listed in the lock enter a reconstructed build. The build verifies source receipts,
input fingerprints and every payload file. Staged binaries were not edited.

### Local checkout synchronization

The older `.engine-staging/sources/pi` and `.engine-staging/sources/prime` authoring copies
were compared with the reconstructed packages. Their native changes are represented in the
locked patch series; no additional unexported fix was found there. Eighteen modified/new Prime
files match the reconstructed files after newline normalization. The remaining changed Prime file
adds the already-packaged speed/image work and the new model-isolation fix. The two changed pi
files have the newer distribution guard that keeps the extension SDK version compatible.

Those older authoring copies are behind the complete patch series. The release checkouts for this
audit are `.engine-staging/source/pi-06a46693-b3763f55` and
`.engine-staging/source/prime-763094e1-da81d67b`, recreated by `engines:prepare` from the lock.
Use those editable checkouts for subsequent work and export changes back into patches. The older
copies were left intact, and the former packaged build is retained under
`.engine-staging/retained-20261014/bundled` for transition checks.

## Reported model switch

The supplied JSONL session was inspected read-only. Its 259 assistant messages all record
`openai-codex/gpt-6.1-sol`. Its model-change entries also select that model, with Max reasoning and
the priority tier recorded. The matching resident reported the same model, Max and priority.
This evidence does not demonstrate a Sonnet provider request in that session. It does not disprove
a transient incorrect picker display.

A separate regression reproduced native model metadata drifting when another session changed its
default model. Fresh workers resolved a model for the creation prefix without retaining it in their
live selection. Later metadata resolution reread the shared defaults, while the existing provider
target could still represent the original model. This could make the UI, context limits and native
provider selection disagree. It is a concrete defect, though the exact reported Sonnet incident was
not captured in the supplied history.

Patch `0013` retains the resolved creation selection in that session. Explicit model selection and
session restoration continue through the native model configuration path. New sessions still resolve
the latest defaults. The patch does not hardcode a preferred model or disable native subagent choices.
The reviewed Prime development head still has the unlatched `creation_model` implementation, so this
local regression remains necessary when evaluating that candidate.

## Settings preservation

Patch `0014` backports upstream
[`7b89c111da0f1d9e67849b34f10552bbb4bd1bd1`](https://github.com/PrimeIntellect-ai/prime-agent/commit/7b89c111da0f1d9e67849b34f10552bbb4bd1bd1).
Preference saves now merge changed fields into the latest document under its native lock. They
preserve unknown fields and other workers' changes instead of serializing an old typed snapshot over
them. Corrupt/non-object settings remain intact. MCP creation accepts the null map produced by older
saves, and rejects malformed documents without replacing them. The upstream tests are included.
The only backport conflict was adjacent to our `Ultrafast` enum arm; its behavior is preserved.

## Integration coverage and gaps

The comparison uses the stable native settings types, daemon command handlers, Python `rlm` runtime,
Vengeance's adapter, helper modes and renderer controls. It is not a claim that every native/TUI
operation has an equivalent desktop control.

| Area                                     | Vengeance integration                                                                                                                    | Remaining limitation or decision                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model, reasoning and speed               | Native catalog and live state; explicit model/thinking commands; account-scoped speed offers; native request transport                   | Existing sessions must keep their own resolved model; fixed by 0013. Already-running old residents need an explicit restart to use the new binary.                                                      |
| Delegation                               | Native `rlm.spawn`, child roster/events, message, resume, cancel, delete, depth controls                                                 | Child model choices remain native. Development-only durable child usage attribution is not present in stable.                                                                                           |
| Resident lifecycle                       | Attach/detach, saved-session identity, app relaunch, isolated restart and old-to-new executable recovery                                 | Installation does not replace running residents. The UI distinguishes running and selected versions.                                                                                                    |
| Goals and autonomous work                | Native goal commands, budgets and autonomy status                                                                                        | No desktop replacement scheduler or agent loop.                                                                                                                                                         |
| Schedules                                | Native heartbeat and cron create/list/manage controls                                                                                    | Native persistence and delivery semantics remain authoritative.                                                                                                                                         |
| Factory, refinement, context and traces  | Native factory controls, refinement, context/system-prompt inspection, side questions, trace inspection/export                           | Large development changes to factory recovery and trace attribution need separate upstream-base qualification.                                                                                          |
| User queues                              | Steering/follow-up queues, preview, atomic deletion through `mutate_queued_message`, clear and Stop returning drafts                     | No dedicated UI for native inter-agent inbox pause/resume/clear, `resume_queue`, or arbitrary queue edits/reordering.                                                                                   |
| Background shell jobs                    | Normal shell/tool execution and native Stop                                                                                              | No dedicated dashboard for native `list_kernel_bash`, `tail_kernel_bash`, `kill_kernel_bash`. Tools can still use the native runtime.                                                                   |
| Settings, models, auth, MCP and packages | Native formats; structured settings plus raw editor; dedicated provider/MCP/package/resource surfaces; helper for native-only operations | Removed `decisionApi.systemOneModel`: the shipped engine has no such setting, and development reverted that experiment. Terminal-only preferences affect native TUI use rather than the desktop layout. |
| Reload                                   | Engine reloads through its bridge; Engine 2 resumes a saved session through a guarded worker restart                                     | Engine 2 has no fully live desktop reload; unsaved sessions cannot take the restart path. Development's new native live reload changes multiple runtime contracts and is not backported here.           |
| External clients                         | Settings watches, state refresh and reattach reconcile native state                                                                      | No dedicated roster subscription; immediate synchronization of changes without a corresponding watched update is not qualified. This is distinct from sibling default leakage.                          |
| Native extension UI                      | Supported by Engine through the native bridge                                                                                            | Engine 2 advertises no pi extension UI; it uses its own skills, kernel and native APIs.                                                                                                                 |

The stable Rust settings types contain 91 leaf settings. The structured settings panel exposes 89;
the remaining two, `mcpServers` and `packages`, have dedicated editors. Comparing those paths finds no
unsupported panel keys after removing the Decision model control. Raw settings remain available for
future keys. No supported native feature was disabled to conceal a mismatch.

## Development changes that were reviewed but not merged wholesale

| Upstream change                                         | Assessment                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prime `7b89c11` settings/MCP preservation               | Backported with tests as 0014; small, relevant persistence boundary.                                                                                                                        |
| Prime `eba4a65` live reload                             | Changes credentials, prompts, model/tool state and reload admission; retain guarded restart until that new contract is qualified.                                                           |
| Prime `d592d5e` durable child usage                     | Broad session/protocol/usage changes; parent costs should not be represented as complete child-inclusive accounting on this base.                                                           |
| Prime `7d191b4` queued agent-message abort preservation | Inter-agent inbox semantics differ from the app's user queue; retain as an upstream qualification item.                                                                                     |
| Prime `6465da8`, `7e86390` compaction changes           | New mid-tool thresholds and thinking/cancel behavior need provider-stream and saved-history qualification. Existing local cancellation patch remains.                                       |
| Prime `3e08932` tool rename                             | Renames `ipython` to `python_repl`; adopting development head would require updating tool matching and fixture contracts together.                                                          |
| pi `5712b13` GPT 6.1 Sol context limit                  | Development adjusts generated catalog data to 500K. The shipped build hydrates its content-addressed upstream catalog; changing a generator alone would not update the packaged model data. |
| pi `d7f7e0d`, `60ac3bc`, `6f2f164`                      | Provider-selection policy, GPT-6 prompt-cache behavior and active-tool restore changes remain candidates for the next stable qualification.                                                 |

The stable policy and reconstruction procedure are in [UPSTREAM.md](../UPSTREAM.md). This update
does not silently promote either engine to development head or reuse a build version for changed
Engine 2 behavior.

## Qualification and artifacts

The reconstructed Engine 2 workspace passed 4,461 Rust tests in 215 test groups, with zero
failures and 14 upstream tests explicitly ignored. Formatting and workspace/all-target Clippy
also passed. The ignored tests require benchmarks, captured local fixtures, an SSE differential
baseline or live environments. The runner separately bootstrapped an isolated Python kernel.
Both real account configuration guards remained unchanged. Vendored `crossterm` still emits five
existing warnings; Vengeance/native workspace Clippy passed with `-D warnings`.

Engine passed its complete upstream suite and filesystem-retention passes. An initial Windows
test cleanup hit a transient `EPERM`; the affected test and then the entire suite passed on rerun.
Native interactive startup/changelog acknowledgement also passed without submitting a prompt.

| Command                                                                     | Final result                                                         | Local evidence                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run typecheck`                                                         | Both TypeScript projects exited 0                                    | `.engine-staging/typecheck-upgrade.log`                                             |
| `npm run build`                                                             | `✓ built in 53.65s`                                                  | `.engine-staging/build-final.log`                                                   |
| `npm run checks`                                                            | `✓ all checks passed`                                                | `.engine-staging/checks-upgrade.log`                                                |
| `node scripts/checks/pi-workspace.mjs check`                                | Passed; real config unchanged                                        | `.engine-staging/pi-upgrade-check.log`                                              |
| `node scripts/checks/pi-workspace.mjs`                                      | `✓ isolated native Engine checks passed`                             | `.engine-staging/pi-native-final.log`                                               |
| `node scripts/checks/pi-changelog.mjs`                                      | Native startup acknowledgement passed                                | Terminal run, exit 0                                                                |
| `RUST_TEST_THREADS=4 node scripts/checks/prime-workspace.mjs --with-kernel` | `✓ isolated native workspace checks passed`                          | `.engine-staging/prime-native-final.log`                                            |
| `node scripts/checks/bundled-engines.mjs`                                   | Both complete payloads, SDK identity and native update guards passed | `.engine-staging/bundled-engines-final.log`                                         |
| `node scripts/checks/prime-auth-native.mjs` and `prime-auth-oauth.mjs`      | Native helper and isolated credential-flow checks passed             | `.engine-staging/helper-native-final.log`, `.engine-staging/helper-oauth-final.log` |
| `npm run dist`                                                              | NSIS and unpacked production package built, exit 0                   | `.engine-staging/dist-final.log`                                                    |
| `node scripts/dist-qa.mjs --dir`                                            | Separate QA package built, exit 0                                    | `.engine-staging/dist-qa-final.log`                                                 |

Artifact identities (SHA-256; payload hashes use the builder's full-file manifest):

| Artifact                                          | Identity                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Engine `1.2.0+vengeance.3` payload                | `b0ab9eb1341f53d1795e9315fcd1b80dae5fb4e2a58ef753834744eab805dad3` |
| Engine 2 `0.10.0+vengeance.5` payload             | `509fec973268a977befbf8aee6573b30ebed7340ad7fe1a01b979bce7c164ee2` |
| Engine 2 executable, staged and packaged          | `527867a1edb67d2774f64882d5ae12a7a0aafb560e3cc8d768634da026e9b7a5` |
| Retained Engine 2 `0.10.0+vengeance.4` executable | `4b1eca49b69bda05ef6afdf0f7d3d3ba8aea1497bd32cb18219af4927cd02770` |
| Packaged native helper                            | `9366465db07222b8c9c5665d19d1e1185441c06bf520a887da64200d4283322b` |
| `release/Vengeance-Setup-0.2.6.exe`               | `877c491deb3584b7ad5c7625b6afc2a0583ec3f55b4b10761ba74290a68738c8` |

The installer was built, not installed or published. Running user residents were not restarted.
Real external-provider sign-in and paid model requests were not part of this qualification;
the native engines used isolated accounts and local scripted providers.

The final app regression matrix passed all 12 selected suites:

```text
PASS engines/bash-queue.qa.mjs
PASS engines/candidate-controls.qa.mjs
PASS engines/candidate-transition.qa.mjs
PASS engines/image-capabilities.qa.mjs
PASS engines/integration.qa.mjs
PASS engines/prime-streaming.qa.mjs
PASS engines/resident-close.qa.mjs
PASS engines/session-recovery.qa.mjs
PASS engines/speed-mode-engine2.qa.mjs
PASS engines/stop-compaction.qa.mjs
PASS engines/updates.qa.mjs
PASS settings/engine-selection.qa.mjs
All 12 suite(s) passed
```

Run these with `node scripts/qa/run.mjs --only <suite>` (repeat `--only` for each suite),
`QA_PRIME_EXECUTABLE` pointing at the staged `.5` executable, `QA_PRIME_SHA256` set to its hash
above, and `QA_PRIME_BASELINE_EXECUTABLE` pointing at the retained `.4` package. The transition
suite checked both actual process executables, changed the worker process and continued the same
native session with its history. Evidence is in `.engine-staging/qa-engine-matrix-final.log` and
`.shots/qa/engine-audit-20261014/`, including executable identity reports.

The new `model-isolation.qa.mjs` regression failed against the retained `.4` build and passed
against `.5`. It also passed in the packaged QA app with executable overrides removed. A sibling
can change the defaults for new sessions without changing its parent; a real native child using
a different model completes while every parent request remains GPT 6.1 Sol / Max / priority.
Restart keeps that selection, native session identity and saved history. The native settings writer
also keeps an unfamiliar plugin setting during the model change.

Packaged QA passed all four matching suites: `engines/model-isolation.qa.mjs`,
`engines/packaged.qa.mjs`, `ext/bundled-extensions.qa.mjs` and `shell/packaged.qa.mjs`.
The native helper loaded with only the Windows system PATH, both engines completed local-provider
turns, the external bridge loaded, and the public sign-in API loaded/cancelled the helper before
credentials were entered. Temporary copies of `pi-openai-codex-compat@0.0.24` and `pi-black@0.1.0`
loaded, survived restart with saved history and completed another turn. Their source installation
was read-only. Package version/About/Settings surfaces passed as well.

The packaged command was:

```sh
QA_PACKAGED_EXE='D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe' \
QA_PI_PACKAGE_ROOT='C:/Users/dev/.pi/agent' \
QA_REPORT_DIR='D:/Coding/vengeance/.shots/qa/packaged-engine-audit-20261014' \
node scripts/qa/run.mjs --only packaged.qa.mjs --only model-isolation.qa.mjs \
  --only bundled-extensions.qa.mjs
# All 4 suite(s) passed
```

Full output is in `.engine-staging/qa-packaged-final.log`. Inspected images include
`.shots/qa/packaged-engine-audit-20261014/engine2-model-isolation-shots/parent-after-restart.png`,
the corresponding `parent-after-child-completion.png`, and
`.shots/qa/packaged-engine-audit-20261014/bundled-extensions-shots/extensions-after-restart.png`.

The final serialized `npm run shots` passed all 16 scenario files and produced 323 screenshots
with zero failures (exit 0, `.engine-staging/shots-final.log`). Its only renderer-error report is
the deliberate malformed-frame input in `transcript-recovery.mjs`, which checks the recovery
boundary and draft retention. Inspected final mock screenshots include `composer-light.png`,
`prime-engine-settings-models-dark.png` and the Engine 2 speed/subagent surfaces in `.shots/`.

Prettier passed for every changed supported file; native Rust formatting passed through the
workspace runner. The final formatting command and output were:

```sh
npx --yes prettier --check scripts/shots.mjs scripts/qa/engines/model-isolation.qa.mjs \
  docs/ENGINE-AUDIT-2026-10-14.md UPSTREAM.md patches/pi/README.md \
  patches/prime-agent/README.md engines.lock.json \
  src/main/engine/prime/configuration-context.ts src/renderer/features/engines/prime-schema.ts
# Checking formatting...
# All matched files use Prettier code style!
```

### Blank QA window

The supplied blank screenshot matched `.shots/composer-FAILED.png` from a run that overlapped a
renderer rebuild. That run lost the UI after the double-Escape/session-tree step. An isolated
composer run against the completed build passed every step, including that tree and light-theme
transition. Replacing lazy-loaded build assets while an app is open is a plausible explanation,
but the earlier harness did not print renderer errors on scenario failure, so the precise error
cannot be confirmed retroactively. The harness now prints those diagnostics on both success and
failure. UI qualification runs are serialized and do not overlap renderer rebuilds.
