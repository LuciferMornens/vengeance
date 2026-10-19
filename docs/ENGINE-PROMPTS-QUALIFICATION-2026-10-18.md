# Engine prompts, restart safety and navigation qualification

This report accompanies [PR #15](https://github.com/LuciferMornens/vengeance/pull/15).
Local Windows qualification is complete for product source
`f35781f987ec22bbecf005a13121e2cc7541b323`. The final 12-suite native, packaged and transition run
passed, as did static gates, all screenshots and performance/scale gates. The earlier broad matrix's
three failures and their clean focused reruns are distinguished below. Final cross-platform checks
and per-platform provenance are recorded on the PR; Windows evidence does not qualify other hosts.

## Scope and product behavior

- Settings exposes the selected engine's native default foundation and an open conversation's
  assembled prompt as distinct views. Current-prompt inspection identifies its snapshot limits.
  Engine 2's static foundation comes from the bundled native helper, separately from a custom engine.
- Scoped SYSTEM, APPEND_SYSTEM and context editing protects drafts, detects conflicting writes,
  bounds content and restores inherited instructions through app file operations. Saving never
  restarts open work; applying saved instructions uses an explicit guarded restart.
- Restart admission checks app operations and native streaming, tools, queues, children, pauses and
  blocking dialogs. Refusals preserve worker identity and history. Prime checkpoints every live
  resident's provider, model and reasoning after preparation fences commands, validates the complete
  recovery roster before commit, and overlays only explicit target changes. Failed-successor recovery
  restores raw backups and checkpointed selections.
- Deferred settings restarts retry temporary refusals and drain changes arriving during restart.
  Dialog tracking releases completed, failed and aborted waits. File-watcher ownership suppresses
  delayed successful app writes without hiding external edits or restoring obsolete ownership.
- Syntax compilation/tokenization runs in a local worker under the existing CSP. The 8 MiB cache,
  stale-result checks, 30-second idle/request termination and plain-source fallback remain bounded.
- Conversation opening acknowledges real input immediately, retains the old pane hidden and inert,
  restores it on failure, and respects newer selections and deliberate focus changes. Authoritative
  history, including empty history, becomes usable before ancillary catalogs/statistics finish.
  Failed opens retain the prior pane's reading position. Cached returns remount scroll observers
  and start at the latest message; explicit mutation refreshes reread history. Paused scrolling
  preserves its anchor when crossing the virtualization threshold.
- Catalog loading/error authority protects native slash-command precedence. Observational failures
  retain an already authoritative catalog; extension reload invalidates and versions that authority,
  fences stale reads and coalesces duplicate reloads. Ambiguous drafts remain until precedence is known.

Local evidence is Windows x64 in the managed worktree, using local providers and isolated accounts,
sessions and kernel environments. Native GUI suites use
`QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts` outside the repository. The mock screenshot
harness owns and removes separate per-scenario system-temp directories. Independent helper fixtures
use temporary directories; `QA_TMP_ROOT` alone
does not prove a helper's `tmpdir()` location unless its launching TEMP/TMP environment is pinned.
Both real account configuration guards passed in the native checks. Live sign-in and paid-provider
behavior are outside this qualification. The installed user application is not a fixture.

Logs live under `.cache`; screenshots and machine-readable reports live under `.shots`. These are
ignored evidence, not shipped artifacts. Windows results do not qualify macOS or Linux.

## Native source qualification

The [stable audit](ENGINE-STABLE-AUDIT-2026-10-18.md) records upstream release identities, comparisons,
patch provenance and retirement criteria. Official release pages/latest-release APIs were rechecked
at 23:27 UTC on 18 October: stable tags remained unchanged and both records were non-prereleases.
pi remains `1.3.0+vengeance.2` at `71023aec1546d6d677a65669c5665c0927ce0dd0`.
Prime is `0.10.0+vengeance.11` at `763094e1b6a7c17450ee8399b06cda1853847ca5`.
Prime patch `0020` backports native append-prompt assembly; `0021` and `0022` change tests only.

### Prime workspace

The reconstructed 22-patch series passed formatting for nine packages / 211 targets and all 216 test
groups: **4,477 passed, zero failed, 14 explicitly ignored**. The normal kernel tests used a temporary
bootstrap. Ignores require external differential servers, private captures, special kernels or
opt-in benchmark/race execution; they are not counted as passes.

```sh
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts \
  QA_NATIVE_TIMEOUT_MS=1800000 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 \
  RUST_TEST_THREADS=4 node scripts/checks/prime-workspace.mjs --with-kernel
```

Clippy subsequently rejected a negated branch in the new append fixture. An equivalent branch
inversion was exported into `0020`; the final reconstruction matched all five authoring files touched
by `0020`–`0022` byte for byte. The full test count precedes that assertion-preserving style edit.

```text
node scripts/checks/prime-workspace.mjs test -p pa-core append_system_tests
  test result: ok. 8 passed; 0 failed
node scripts/checks/prime-workspace.mjs clippy --workspace --all-targets -- -D warnings
  Finished `dev` profile [unoptimized] target(s) in 23.99s
  ✓ isolated native workspace checks passed
  ✓ both real account configurations remained unchanged
```

Evidence: `.cache/prime-workspace-clean.log`, `.cache/prime-append-style-final.log` and
`.cache/prime-clippy-style-final.log`. Earlier `.cache/prime-workspace-tests-final.log` recorded
4,476 passes, one failure, 14 ignores and external cleanup of an ACP fixture daemon: it is diagnostic,
not clean qualification. `0021` replaces inherited stderr-pipe joins with file diagnostics and bounded,
acknowledged fixture shutdown. `0022` adopts upstream's test correction: 40 rounds with two writers
still assert all 80 writes. The original lock fixture failed five isolated repeats; runtime lock
behavior and timeouts were not changed. The clean full run required no such intervention.

### pi workspace

The unchanged seven-patch series passed complete native qualification: **7,532 passed, 957 skipped**,
including normal and zero-retention durable passes. The TUI suite passed without a numeric summary
from its upstream dot reporter. Skips include credential-dependent providers and external/SSH fixtures.

```text
node scripts/checks/pi-workspace.mjs check
node scripts/checks/pi-workspace.mjs
  ✓ isolated native Engine checks passed
  ✓ both real account configurations remained unchanged
node scripts/checks/pi-changelog.mjs
  exit 0
```

Coverage includes Biome over 1,491 files without fixes, TypeScript, catalog/runtime/import checks and
browser smoke. The real-PTY changelog check acknowledged 1.3.0, preserved an unrelated preference and
submitted no prompt. A long-path renderer fixture failure and two junction-run compaction failures
were diagnostic; the latter passed alone. Clean qualification used a short physical reconstruction,
fresh locked dependencies and an offline build, without pi product/patch changes. Source fingerprint
`f836ef42e6989b56c4ee1d6f9fa322398ff16865baac808267a5bb0a10d7f829` matched before/after.
The physical fixture and junction were removed safely. Evidence is
`.cache/pi-workspace-{check,tests,changelog}-final.log` and its source receipt.

## Native payloads, helper and integration repairs

`npm run build:engines` reconstructed exported patches and staged complete Windows payloads. Prime
built in 4m 50s with 61 files; the helper rebuilt against final engine source in 1m 49s. pi's payload
matches the retained `.2` package. These native identities are separate from app-package freshness.

| Artifact / receipt                          | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| pi `.2` payload                             | `97f796c58c176d6f78f1bbb45564c26225d53826bcb34b479865900002d18a39` |
| Prime `.11` payload                         | `64f695dd72aa9ddad9a41b3e70344522512c50654c89a2d78a6164ff14f654b2` |
| Prime `.11` executable                      | `d5b58cad3bb96f2c7075626cbf4215125ad8a118281b10a2717904d0ebdbdad1` |
| Helper through `3aff7fd`                    | `1de7bea53c7f128ba5e7801e5570ac3b34e996475b1069a13f8a4b471df6774f` |
| Helper input fingerprint                    | `3e3b05f12545b8099352dcf2a36316f3240932eb36ee7422296a920111a40847` |
| Retained complete `.10` baseline executable | `764badef53b7bd986d6ca125f86ccd6b6806a2489819ccb95b6342eae7089561` |
| Final Windows QA executable                 | `ddb1938a8138aacce52d37e015ed3122b655d076764e3d178eece484e7c8b7ab` |
| Final Windows QA app archive                | `4f5a16f8ffe31f3acbb87d5bf1b6b41a3cdf81096393c6497bd32cacb3765602` |

The fresh isolated QA package was produced from final product source `f35781f` with
`node scripts/dist-qa.mjs --dir`; `.cache/package-scroll-final.log` records exit 0 and verification of
all 14,932 pi files and 61 Prime files. Its packaged helper and Prime executable hashes match the
table above. The earlier `0f05f78` package and its packaged passes do not qualify these final bytes.

The helper passed rustfmt, ten release-profile tests and all-target release Clippy with warnings
denied, using locked dependencies and the builder's patched native overrides. Both account guards
passed. `.cache/native-helper-terminal-owner-qualified.log` records the latest helper result:

```text
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts node .cache/native-helper-check.mjs
  test result: ok. 10 passed; 0 failed
  Finished `release` profile [optimized] target(s) in 0.99s
  Native helper formatting, tests and clippy passed
  Both real account configurations remained unchanged
node scripts/checks/bundled-engines.mjs
  ✓ pi 1.3.0+vengeance.2: system PATH, native self-update refusal, config intact
  ✓ prime 0.10.0+vengeance.11: system PATH, native self-update refusal, config intact
  ✓ bundled native engine checks passed
```

Direct helper API-key, OAuth, trace-settings and restart/rollback checks passed. The real pi bridge
passed prompt inspection, reload and session preservation. Watcher qualification expanded to ten
cases: failed replacement must not acquire ownership (`a107411`); failed asynchronous removal must
not restore obsolete ownership (`e7d876d`). Concurrent failed removals, external edit/revert and newer
saves are covered. Red/green logs are `.cache/instruction-watcher-removal-red.log` and
`.cache/instruction-watcher-removal-qualified-final.log`; failed-write evidence is
`.cache/instruction-watcher-failed-write-qualified.log`.

Native helper/adapter regressions passed changed target and sibling selections, explicit overrides,
queued resets, exact raw backup rollback and failed-successor recovery. Incomplete/malformed peers
refuse before commit. `3aff7fd` accepts terminal import-service descriptors only with a native stop
marker and provably departed owner; live, unknown or mismatched resident/session identities still
refuse. A verified different process-start identity establishes a departed owner after PID reuse.
Descriptor filenames are also checked. Resident transport recovery preserved
native identity and updated worker PIDs after idle-peer restart.

```text
node scripts/checks/prime-restart-native.mjs
  Native restart validated every live selection; target overrides, peer choices and rollback recovery passed
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts node scripts/checks/prime-adapter-real.mjs --restart-qa
  Prime public adapter real-native QA passed
  exit 0
```

Evidence: `.cache/prime-restart-selections-helper.log`, `.cache/prime-restart-live-selections.log`,
`.cache/prime-restart-terminal-owner-helper-final.log`, `.cache/prime-restart-import-qualified.log`
and `.cache/prime-identity-native-qualified.log`. Synthetic incomplete-identity failures remain
diagnostic. A native fixture initially generated 11 Python bytecode files inside staged skills;
`90b530f` redirects them to temporary storage. Only those generated files/empty directories were
removed; the original payload hash matched and the rerun left it unchanged. No staged binary changed.

## App, visual and performance evidence

The final product source, `f35781f987ec22bbecf005a13121e2cc7541b323`, passed both TypeScript projects,
all offline checks, build and engine/helper integrity. Prettier and `git diff --check` passed;
independent source reviews found no remaining actionable issue, debug leftovers or shipped test hooks.

```text
npm run typecheck
  tsc --noEmit -p tsconfig.node.json
  tsc --noEmit -p tsconfig.web.json
  exit 0
npm run checks
  ✓ all checks passed
npm run build
  ✓ built in 18.15s
```

Logs: `.cache/{typecheck,checks,build}-scroll-event-only.log` and
`.cache/formatter-final-branch.log`. Final `npm run shots` passed all 20 scenario files and wrote
383 captures, recorded in `.cache/shots-scroll-final.log`. All 11 fresh prompt captures were visually
inspected across both engines,
themes, current/default/no-session views, conflict, unsaved, restore and narrow-editor states. Review
disposition was ship, with no material fixes, using the disclosed generic-agent Impeccable fallback
protocol. SPEC.md and docs/DESIGN-SYSTEM.md remained authoritative; detector output was `[]`.
The transcript-recovery null/trim log is an asserted malformed-frame fixture, not normal rendering.

Final source hygiene review covered 87 changed handwritten source, test and script files. None
exceeded 800 lines (maximum 798), and no added shipped debug logs or private test hooks were found.
`git diff --check 8b2319880580893356d7cc7d2fbc721c08936bf9 f35781f` exited 0. Later report-only
commits do not change the measured or packaged product source.

At `7214218`, real-native integration passed in 89.9s and all **19 foreground-opening checks** passed
in 18.1s, including native reload shadowing, retained drafts, ready cached opens, empty history,
focus, rename cancellation, race handling and failed-open recovery. `74fe7e9` separates model/catalog
timers and preserves valid observational authority; `7214218` fences extension-reload reads. Public
regressions failed before each repair. `.cache/qa-reload-final.log` ends:

```text
PASS  engines/integration.qa.mjs  (89.9s)
PASS  sessions/open-feedback.qa.mjs  (18.1s)
All 2 suite(s) passed
```

The [performance report](PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md) owns methods, commands, sample
hashes, profiles and complete metrics. On final source `f35781f`, `paired-scroll-final` and
`bundled-scroll-final` passed all **12 strict cold samples**. All three scale suites passed:
1k/3k/10k tools, native Prime **3,000 tools**, and **8,300 saved histories across 65 workspaces**.
All 12 renderer profiles contain zero sampled Shiki-engine CPU. Paired first-visit blocking fell
from 128ms to 4ms for Engine and from 122ms to 19ms for Engine 2. Engine's first/second opens improved
from 825/544ms to 491/340ms; Engine 2's changed from 877/487ms to 901/549ms. Cached returns also
regressed by approximately 20–25ms. These are mixed wall-clock results, not a claim that both engines
open faster. A roughly 210ms startup scheduling gap remains. Six baseline samples
passed timing/identity/source/syntax checks but failed upward scrolling; baseline-only diagnostics
recorded `qualified: false` and exited nonzero. Candidate runs retained strict failure behavior.
Final scale evidence records Engine's 10k-tool opening at 864ms with a 70ms cached return, Prime's
3k-tool cold openings at 833–842ms with cached returns at 41–57ms, and the full workspace corpus
opening at 1.392s. Fresh timing and scale screenshots were visually inspected.

Final native restart QA passed **all 12 checks** on `f35781f`, including real tool continuations,
parked pi queues, explicit Prime selection resets, a working Prime child and a busy sibling.
`.cache/qa-restart-safety-clean-final.log` records the clean pass after the test publication fix.
Cleanup verified zero owned QA processes and the unchanged creation identity of the installed
user daemon. Screenshots and the structured report are under
`.shots/qa/final-f35781f/native/restart-safety-shots`.

```text
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts node scripts/qa/engines/restart-safety.qa.mjs
  ✓ Restart safety: 12 native checks passed
  exit 0
```

## Broad matrix failures and completed repairs

`.cache/qa-final-matrix.log` records **20 PASS / 3 FAIL across 23 suites**. Passed suites cover syntax,
activation, shell/queues, engine handoff, images, model isolation, resident closure, notices, recovery,
speed, Stop/compaction, updates, session concurrency/lifecycle/workspace focus, preferences, engine
selection, raw/external settings, launch options and trust. This matrix is not a complete pass;
all three failures have subsequent clean focused reruns on final product source.

| Failed suite                     | Observed failure and present status                                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat/transcript-scroll.qa.mjs`  | Silent upward scrolling during streaming moved 412px back toward bottom. The public coalesced-growth regression reproduced a 413px jump. Commit `f35781f` fixes that event boundary; the exact final suite passed in 67.1s.  |
| `engines/restart-safety.qa.mjs`  | Tool UI still reported `running` after native completion. Test-only `93906a8` waits for completed-state publication; all 12 native checks passed on the final rerun.                                                         |
| `settings/system-prompts.qa.mjs` | Both engines' prompt assertions passed, then cleanup failed with `EBUSY` and an owned Prime daemon remained. After `b2b1841`, both engines and normal fixture cleanup passed with exit 0 and zero owned processes remaining. |

The cleanup record `.cache/qa-prompts-cleanup-final.log` distinguishes the owned temporary daemon
from the installed user's daemon and records `Owned endpoint shutdown response: true`. External
cleanup does not convert the failed suite into a clean pass. Earlier broad attempts (15/18 and a
three-suite rerun) exposed stale expectations, live-selection restoration and terminal import-owner
handling; their fixes have focused evidence above, but those attempts remain diagnostic logs.

QA-only commit `b2b1841` replaces PID-only foreign-process snapshots with PID/creation identities.
The former check could skip a new owned daemon when its PID reused an expired process from the
snapshot. That is a demonstrated reachable defect, not a confirmed explanation of this particular
leak: the original creation snapshot was not retained. Cleanup now checks the full executable and
endpoint and revalidates exact creation identity before forced termination. Coarse macOS timestamps
can protect a foreign process but cannot authorize a forced stop. Independent review cleared the
change; fixture cleanup attempts every child even after an earlier cleanup failure.

```text
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts node scripts/checks/qa-daemon-cleanup.mjs
  PASS a reused PID with a newer creation identity is shut down gracefully
  PASS an alive foreign process with the same PID and creation identity is protected
  PASS executable paths and endpoint arguments must match exactly
  PASS a foreign process with an unknown creation time remains protected
  exit 0
```

The four public protocol checks, formatter, syntax checks and diff checks passed. Evidence is
`.cache/qa-daemon-cleanup-qualified-final.log`. The installed daemon remained running, and all
identified temporary daemon, worker and Python processes exited after acknowledged shutdown.
The clean native prompt rerun is `.cache/qa-system-prompts-clean-final.log`; both SYSTEM/APPEND
provider payloads, held-save preservation, explicit guarded apply, scope precedence and restore
passed. `.cache/qa-final-process-cleanup.log` records zero owned processes and the installed daemon's
unchanged creation identity after both final native suites. No `EBUSY` or cleanup warning occurred.

```text
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts node scripts/qa/settings/system-prompts.qa.mjs
  ✓ pi: native requests reflect only explicit apply; account and scope isolation passed
  ✓ prime: native requests reflect only explicit apply; account and scope isolation passed
  ✓ system-prompts passed
  exit 0
```

Automatic approval review blocked deletion of the two abandoned fixture folders, including a
nonrecursive file-by-file attempt after checking every path and excluding reparse points. Neither
deletion ran. The remaining roots are `vengeance-qa-run-rbuzFd` (68.7 MB) and
`vengeance-qa-engines-D7ECf0` (62 KB), under `D:/Coding/vengeance-qa-engine-prompts`.
Within the managed worktree, individual-file cleanup removed 55.3 GB of disposable helper build
scratch, a receipt fixture, a byte-identical duplicate baseline output and three alternate indexes.
The retained baseline, packaged app and review evidence remain available. Final package hashes
were checked again after QA and cleanup and still match the table above.

The final product-source revision is `f35781f987ec22bbecf005a13121e2cc7541b323`. The scroll
repair changes only the existing scroll-event predicate and its comment: a silent upward scroll
can coincide with streamed growth. The regression drives actual provider paragraphs and public
`scrollTop`, then checks the same position over two later growths. Original assertions remain.
New checks cover real animated tool collapse during streaming, growth targets reached within the
existing 150ms follow budget, a positive number of sampled growths, and strict bottom position
after settlement. A broader draft that took over browser anchoring was rejected after it caused
a real post-Jump settlement failure; none of that draft's policy or extraction remains.

```text
npm run typecheck
  tsc --noEmit -p tsconfig.node.json
  tsc --noEmit -p tsconfig.web.json
  exit 0
npm run checks
  ✓ all checks passed
npm run build
  ✓ built in 18.15s
node scripts/qa/chat/transcript-scroll.qa.mjs
  ✓ chat-transcript-scroll passed (67.1s)
node scripts/qa/chat/transcript-activation.qa.mjs
  ✓ chat-transcript-activation passed (7.4s)
node scripts/qa/sessions/open-feedback.qa.mjs
  ✓ sessions-open-feedback passed (17.9s)
```

Both independent source reviews cleared the final change. A separate forced DOM experiment shrinks
content, forces intermediate layout, then grows content in the same task. Its final geometry is
indistinguishable from an unannounced upward scroll, and the candidate conservatively pauses follow
with a 400px gap. This diagnostic did not pass an auto-follow assertion. No supported app operation
producing that sequence was identified; real collapse/streaming, content-visibility settlement and
paused anchoring passed. The limit and reproducible ignored diagnostic are retained rather than
claimed as solved. Evidence is `.cache/qa-scroll-event-only-lag.log` and
`.cache/scroll-forced-clamp-diagnostic.mjs`; exact required-suite results are in
`.cache/qa-scroll-event-only-final-exact.log`, `.cache/qa-scroll-event-only-threshold.log` and
`.cache/qa-scroll-final-feedback.log`. Static logs are `.cache/typecheck-scroll-event-only.log`,
`.cache/checks-scroll-event-only.log` and `.cache/build-scroll-event-only.log`.

## Final packaged and transition checks

The fresh Windows package passed the four-suite native/shell/compatibility batch. This checks actual
bundled engines, external bridge loading, model isolation through a working child and restart,
helper loading with only the Windows system PATH, version displays and compatibility extensions.
`pi-openai-codex-compat` 0.0.26 and `pi-black` 0.1.0 were copied from the installed package source
into isolated QA storage; the source account and credentials were not used as writable fixtures.
Screenshots are under `.shots/qa/final-f35781f/packaged`.

```text
QA_PACKAGED_EXE=C:/Users/mitte/.codex/worktrees/engine-prompts-performance/vengeance/release/qa/win-unpacked/VengeanceQA.exe \
QA_PI_PACKAGE_ROOT=C:/Users/mitte/.pi/agent \
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts \
node scripts/qa/run.mjs --only packaged.qa.mjs --only model-isolation.qa.mjs \
  --only bundled-extensions.qa.mjs
  PASS engines/model-isolation.qa.mjs (42.8s)
  PASS engines/packaged.qa.mjs (29.5s)
  PASS ext/bundled-extensions.qa.mjs (23.5s)
  PASS shell/packaged.qa.mjs (5.0s)
  All 4 suite(s) passed
```

Evidence: `.cache/qa-packaged-four-final.log`. Cleanup found zero owned QA processes and the same
installed daemon creation identity after the batch.

The same package then passed syntax/highlighter-worker/CSP checks, all 19 opening-feedback checks
and both engines' complete prompt suite. Prototype and unknown grammar identifiers were refused,
followed by a valid highlighted worker request. Public input acknowledgment was 8.7ms by mouse and
16.6ms by keyboard in this packaged run. These observations supplement the controlled benchmark;
they are not additional cold-navigation benchmark samples.

```text
QA_PACKAGED_EXE=C:/Users/mitte/.codex/worktrees/engine-prompts-performance/vengeance/release/qa/win-unpacked/VengeanceQA.exe \
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts \
node scripts/qa/run.mjs --only chat/code-highlight.qa.mjs \
  --only sessions/open-feedback.qa.mjs --only settings/system-prompts.qa.mjs
  PASS chat/code-highlight.qa.mjs (2.7s)
  PASS sessions/open-feedback.qa.mjs (18.1s)
  PASS settings/system-prompts.qa.mjs (55.2s)
  All 3 suite(s) passed
```

Evidence: `.cache/qa-packaged-prompts-highlight-open-final.log`. All 12 packaged captures were
visually inspected. Cleanup again left zero owned QA processes and the protected installed daemon
unchanged. Native restart and scroll suites ran against the built application; their harnesses do
not select the packaged executable, so they are not described as packaged passes.

The final three built-application suites passed four native control/restart checks, three actual
executable-transition checks and eleven mixed-version resident-upgrade checks. The retained `.10`
baseline already includes the live-vision fix, so the suite explicitly expects working native vision.
The transition observed the real worker change from baseline hash `764badef…` to candidate hash
`d5b58cad…`, retaining native identity and saved history, then successfully continuing the conversation.
Resident checks also cover relaunch, live/selected version notices, native model capabilities and
actual tool-image bytes after explicit restart. These suites use the built app, not the QA package.

```text
QA_PRIME_EXECUTABLE=C:/Users/mitte/.codex/worktrees/engine-prompts-performance/vengeance/.engine-staging/bundled/prime/prime-agent.exe \
QA_PRIME_SHA256=d5b58cad3bb96f2c7075626cbf4215125ad8a118281b10a2717904d0ebdbdad1 \
QA_PRIME_BASELINE_EXECUTABLE=D:/Coding/vengeance/.engine-staging/bundled/prime/prime-agent.exe \
QA_PRIME_BASELINE_SHA256=764badef53b7bd986d6ca125f86ccd6b6806a2489819ccb95b6342eae7089561 \
QA_PRIME_BASELINE_VISION_SWITCH=working QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts \
node scripts/qa/run.mjs --only candidate-controls.qa.mjs \
  --only candidate-transition.qa.mjs --only resident-upgrade.qa.mjs
  PASS engines/candidate-controls.qa.mjs (43.8s)
  PASS engines/candidate-transition.qa.mjs (42.7s)
  PASS engines/resident-upgrade.qa.mjs (70.4s)
  All 3 suite(s) passed
```

Evidence: `.cache/qa-prime-transitions-final.log` and
`.shots/qa/final-f35781f/transition`. All 44 captures across the final native/package/transition
batches were inspected. At 200% zoom the resident suite's native 880×700 capture is the complete
responsive evidence; its paired CSS-sized capture is cropped by Electron's zoom behavior. Final
cleanup verified no owned QA apps, workers or Python children, the unchanged installed daemon,
and unchanged baseline/candidate executable hashes. No source edits followed these runs.

## Cross-platform release evidence

Release dry runs now emit per-platform provenance after packaged smoke: app version, native
inventories/lock identities, actual packaged-helper probe/hash and hashes of uploaded release files.
The receipt fixture passed hashing/summary agreement and empty/foreign-platform refusal using an
earlier QA app; that validates the reporting tool only. A ZIP artifact digest identifies the ZIP,
not each contained binary. The CI-generated receipts separately identify packaged native/helper
bytes and release-file hashes. The PR records the exact final head, workflow/job outcomes and receipt
artifact links for Windows x64, macOS arm64/x64 and Linux arm64/x64. Earlier green runs remain
historical evidence; only the final-head checks determine readiness. Artifact metadata is available
through public REST, but authenticated ZIP download is required to retrieve receipt contents;
an archive digest is not presented as an independently retrieved native or package hash.
