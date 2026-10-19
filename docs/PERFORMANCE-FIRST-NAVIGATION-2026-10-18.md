# First conversation navigation performance — 18–19 October 2026

The measured application at `f35781f` removes all sampled Shiki engine CPU from the renderer.
First-visit long-task blocking falls from 128 to 4 ms with Engine and 122 to 19 ms with Engine 2:
97% and 84% reductions. Syntax colors and literal source remain correct. Twelve final cold-process
samples, 19 opening-feedback checks, native integration, and all three scale suites pass.

Wall-clock results remain mixed. Engine's first and second conversation visits improve about 40%
and 38%. Engine 2's first visit takes 3% longer and its second visit takes 13% longer. Cached returns
cost another 25.0 ms with Engine and 19.9 ms with Engine 2. A roughly 210 ms startup frame gap remains.
These results demonstrate less renderer blocking and immediate opening feedback; they do not show
every navigation or launch
becoming faster.

The supported silent-scroll regression and real collapse/streaming checks pass. A separate forced
same-task shrink/read/grow diagnostic still conservatively pauses following. That geometry ambiguity
is an explicit limitation, with its failing evidence retained below; it is not counted as a passing gate.

## Scope and endpoints

Windows x64, Electron 44.7.0, built development application, 1440 × 900, Mica disabled. Each series
uses three fresh processes per backend with new Chromium profiles and temporary engine accounts.
This is process-cold measurement; operating-system filesystem caches were not flushed. New Engine 2
profiles include their first bundled-runtime copy. Three samples are insufficient for a general
statistical claim or qualification on other operating systems.

Two conversations in one workspace each contain 60 turns and 421 messages, including read/bash/edit
results, tables, and TypeScript/Python code. Engine 2 histories use the public handoff/native writer.
No provider requests create or open the measured histories. Each process launches to shell/fonts
ready, opens the first saved conversation, opens the second for the first time, then returns to the
cached first conversation. CPU profiling spans the three visits.

The headline `visibleMs` endpoint observes the exact final marker paragraph intersecting both the
transcript viewport and window, with inherited visibility/opacity and no inert/opening layer.
`paintedMs` retains the historical mounted-DOM observation and is not used in the headline tables.
Neither endpoint promises every asynchronous syntax token or scroll correction has settled. Strict
post-timing checks require syntax colors, exact source, actual bottom position, real upward wheel
scrolling, Turn 0 remaining stable, and Jump to latest returning to the bottom.

Timed public session actions bypass the sidebar's 250 ms double-click-to-rename window. Public mouse
and keyboard acknowledgment is measured separately. All baseline/final headline reports record
`traceEnabled`, `diagnoseFrames`, `focusWindow`, and `warmFrames` as false.

Baseline output was built before product edits from local `0db898b`. Its real-engine and renderer
code matches official main `8b23198`; the intervening product difference is a mock filesystem fixture.
The candidate source is `f35781f987ec22bbecf005a13121e2cc7541b323`. Baseline/paired runs hold engine payloads at Engine
`1.3.0+vengeance.2` / Engine 2 `0.10.0+vengeance.10`. Separate bundled runs use Engine 2
`0.10.0+vengeance.11`. This is a payload-controlled application comparison: main integration and the
native helper also changed, and baseline collection precedes the final helper repair. CPU profiles
identify removed highlighting work directly; wall-clock deltas cannot be attributed solely to the
renderer.

## Fresh visible-marker comparison

Medians of three runs, milliseconds; `baseline-visible.json` and `paired-scroll-final.json` under
`.shots/perf/first-navigation/`.

| Measurement                                   | Engine before | Engine after | Engine 2 before | Engine 2 after |
| --------------------------------------------- | ------------: | -----------: | --------------: | -------------: |
| Launch to shell and fonts                     |         327.8 |        325.2 |           327.5 |          322.1 |
| First conversation, first visit               |         825.4 |        490.6 |           876.7 |          901.3 |
| Second conversation, first visit              |         544.1 |        339.9 |           487.3 |          548.8 |
| Return to first conversation                  |          46.0 |         71.0 |            28.5 |           48.4 |
| Renderer Shiki engine CPU across three visits |         162.5 |            0 |           150.1 |              0 |
| First-visit long-task blocking                |           128 |            4 |             122 |             19 |
| Second-visit long-task blocking               |             7 |            0 |               0 |              0 |
| Longest first-visit frame gap                 |         228.6 |        210.6 |           211.9 |          209.7 |
| Longest second-visit frame gap                |         114.6 |        120.4 |            33.3 |          124.9 |

The baseline is explicitly **unqualified for scrolling**. All six baseline samples passed native
identity, exact source, syntax, and visible-marker checks, then failed upward-wheel history visibility:
virtualized history stayed blank. Baseline-only `--record-scroll-failures` collected every timing and
failure capture, recorded `qualified: false` / six scroll failures, and exited 1. It does not catch
setup, identity, syntax, or visibility failures. Both candidate series use strict defaults; all twelve
samples pass every check with zero scroll failures.

Long-task blocking sums only the portion of each observed task exceeding 50 ms; work outside a
navigation observer can be absent. CPU profiles span the whole three-visit interval. Shiki CPU uses
the `engine-javascript-*` script URL. Every candidate renderer profile has zero such samples, while
local worker targets and real syntax tokens are present. Highlighting still performs work in its worker.

## Engine 2 second-visit cost and remaining gap

With fixed `.10` payloads, second visible visits range from 482.4–489.8 ms before and 544.4–571.5 ms
afterward. Of the 61.5 ms median increase, the native/main `engine:create` boundary accounts for
49.8 ms: 449.0 → 498.8 ms, about 81% of the delta. The residual between visible and create-handler
medians rises from 38.3 to 50.0 ms. That residual includes work before and after the handler, rather
than measuring only renderer work after native completion. The probe times the main handler around
`await handler(...)`; it does not identify
a native-only cause. Both series have zero second-visit long-task blocking. A larger frame gap alone
cannot establish a synchronous renderer freeze.

The requested marker appears 50.4–59.5 ms before the complete opening action finishes ancillary reads.
History is therefore usable before the full command/catalog operation completes. Compared with the
earlier feedback candidate `e7d876d`, Engine 2's paired second visit improves from 609.3 to 548.8 ms
and cached return from 61.7 to 48.4 ms, while remaining slower than baseline. These are separate series,
not an isolated causal estimate of readiness work.

Read-only baseline-to-final source review found no added awaited startup operation: the create IPC
handler is unchanged; manager creation adds operation counting and a dialog Map; Engine 2 start,
attachment, transport, and location paths are unchanged. Its process changes concern restart/bridge
dispatch. No concrete new startup operation explains the measured difference; no speculative product
optimization or benchmark warmup was added.

Earlier diagnostics observed a 236.2 ms gap during twelve idle startup frames with no navigation.
After warmup, navigation still took 475.2 ms with an 89.8 ms maximum gap. Tracing starts after optional
warmup, so that warmup gap itself was not traced. A separate marked timeline captured a 166.7 ms
startup navigation gap before history arrived: every overlapping renderer `RunTask` was at most
1.56 ms, then Chromium produced `ScheduledActionSendBeginMainFrame`. That capture establishes mostly
idle renderer time during its own gap. Correlation with the idle warmup observation supports startup
frame scheduling; compositor/driver/operating-system cause remains unresolved. Individual final gaps
were not traced. Native wait does not itself explain an idle renderer frame gap. Global throttling
settings were not changed.

| Diagnostic artifact label | Extra flags                                      |
| ------------------------- | ------------------------------------------------ |
| `frames-raw`              | `--diagnose-frames`                              |
| `frames-focused-warm`     | `--diagnose-frames --focus-window --warm-frames` |
| `frames-timeline`         | `--diagnose-frames --trace`                      |

These artifacts and `frames-timeline-pi-1.trace.json` are separate from the cold-process medians.

## Actual bundled build

`bundled-scroll-final.json` uses Engine `.2` / Engine 2 `.11`, another three fresh processes per backend.

| Measurement                      | Engine | Engine 2 |
| -------------------------------- | -----: | -------: |
| Launch to shell and fonts        |  326.0 |    322.5 |
| First conversation, first visit  |  503.3 |    908.6 |
| Second conversation, first visit |  343.5 |    540.9 |
| Return to first conversation     |   68.3 |     53.0 |
| First-visit long-task blocking   |      4 |       19 |
| First-visit maximum frame gap    |  210.0 |    208.4 |
| Second-visit long-task blocking  |      0 |        0 |

Engine 2 first visits range from 840.1–921.8 ms; second visits from 540.1–590.2 ms. Second-create
handler durations range from 490.4–541.2 ms, tracking much of the variation. All six strict samples
pass. These final-artifact measurements are separate from the fixed-`.10` comparison.

## Implementation and public interaction evidence

Shiki initialization, grammar compilation, and tokenization run in `highlight-worker.ts`.
`highlight.ts` retains the bounded 8 MiB cache, request coalescing, monotonic IDs, stale code/language
checks, and CSS-variable theme colors. The explicit grammar Map rejects unknown/prototype names.
Worker failures fall back to plain source; idle/request timeouts terminate it after 30 seconds.
Vite emits a local ES module worker under the existing CSP. Packaged syntax QA proves TypeScript
keyword/string/comment and Python keyword colors, exact source, prototype-name fallback, and a valid
request succeeding after rejected messages.

Pinned transcripts start near the end with zero offscreen overscan; upward readers get the normal
six-row buffer. Earlier diagnostic traces reduced maximum style-recalculation elements from 9,166
to 3,973, total style time from 123 to 71 ms, and layout from 69 to 46 ms across three visits. Those
single-run traces demonstrate removed layout work, not controlled final latency estimates.
Callback-ref scroller state installs virtualizer observers on cached returns. Pinned compensation
uses the transcript follow policy; unpinned writes use TanStack element scrolling. Threshold crossing
while reading snapshots the visible key, offset, and measured row sizes. The tall-midpoint regression
failed before this fix and passes afterward, keeping its heading within 12 px and Jump working.
At most 80 settled head segments still use the plain path.

The silent-scroll regression uses a real streamed paragraph update: a public MutationObserver scrolls
the transcript upward 300 px in the growth microtask, then the provider sends two more growths. Before
the fix, the scroll event arrived before ResizeObserver, but the height-equality classifier ignored
the upward scroll because content had grown 38 px. Following overwrote it; the view moved another
413 px. The final classifier accepts an upward scroll alongside nonshrinking content. The same
regression keeps its exact requested offset afterward. It changes only the scroll-event classifier;
normal browser anchoring and resize following remain in place.

Full scroll QA passes pure tool-collapse/clamping, real tool collapse while large chunks stream,
growth targets reached within the existing 150 ms follow budget, no detached cue, strict bottom after
settlement, original silent scrolling, Jump, cached/initial loading, tree rewind, and paused threshold
crossing. The sampled collapse window must contain at least one eligible growth, so its budget cannot
pass vacuously. Captures on failure use the current relaunched app before shutdown.

There is a known geometry limit. The non-gating diagnostic deliberately shrinks content above by
300 px, forces a geometry read that clamps the outer scroll range, then grows content below by 400 px
in the same task before queued scroll/resize delivery. Its final top/height are indistinguishable from
silent reader movement. The final application conservatively pauses: top 25,947 → 25,647 with final
height 26,863, 400 px off the bottom. The exact forced diagnostic fails its auto-follow assertion;
it is not reported as a pass. No supported application operation reproducing that exact same-task
sequence was identified in source review or the real collapse/stream/settle test. A broad anchoring
redesign was avoided; this limitation remains open. Reproducible ignored diagnostic and failing evidence:
`.cache/scroll-forced-clamp-diagnostic.mjs`, `.cache/qa-scroll-event-only-lag.log`, and
`.shots/qa/chat-transcript-scroll-forced-clamp-EVENT-ONLY.png`.

Closed-row clicks show the shared Spinner during the rename delay. Keyboard activation starts
directly. Native opening shows the shared Shimmer; the old pane stays mounted, hidden, and inert.
Failure restores its reader position. Counts/focus ownership belong to the latest activation revision.
Double-click/F2 rename and newer selections cancel deferred timers. The layer ends once the verified
engine/path commits full history, including empty history, or a native snapshot. Streaming/capability
metadata alone cannot prove readiness. Ready cached sessions bypass a pending cycle; duplicate opens
and open-row selection join initial hydration. Explicit post-mutation refreshes always read again.
Focus honors deliberate sidebar/settings movement. Hidden composers reject global file drops while
preventing browser navigation; normal drops and ongoing decoding keep their behavior.

Catalog loading/ready/error authority preserves native slash-command precedence. Ambiguous built-ins
keep the draft until known; free text stays usable. Failed observational refresh retains an already
authoritative matching catalog. Engine replacement resets it. Separate capability/model timers stop
settled model reads canceling catalog discovery. Extension reload invalidates catalog revision before
and after mutation, blocks interim publication, coalesces duplicate reloads, and cleans up in `finally`.
Stale reads cannot restore old authority; native errors keep priority and closed reload rejects.
Public regressions reproduce timer/reload failures before their fixes and pass afterward.

Native integration passes `/speed on`, unsupported `/bug`, and restart/import controls. All 19 public
feedback checks pass, including a real extension adding `/new` on reload with failed catalog refresh:
draft retained, no app session opened. Final input observations: mouse acknowledgment 8.5 ms, center
cue 279.0 ms including rename delay, keyboard acknowledgment 12.2 ms. These are one mouse and one
keyboard observation after baseline history opened, not statistical/cold-process estimates; no model
requests are made by this focused suite.

## Scale gates

All run against output matching `f35781f`, isolated accounts, strict defaults.

| Gate                                      | Observed result                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Engine 1k / 3k / 10k tools                | Opens 852 / 852 / 864 ms; cached 69 / 69 / 70 ms; seven mounted segments each                                                        |
| Three largest-history reopen/close cycles | Pass; only scratch engine remains; retained renderer heap 3.5 MiB                                                                    |
| Engine 2 native 3k tools, three cycles    | Twelve gates pass; cold 833–842 ms, resident 316–335 ms, cached 41–57 ms; frame gaps ≤67 ms                                          |
| Engine 2 history integrity/cleanup        | Renderer growth 1.63 MiB, main 0.84 MiB; digests/tool pairs pass; zero provider requests                                             |
| 8,300 conversations / 65 workspaces       | Full suite, zero failures; primary ready 1.39 s; 23 initial rows; picker/groups/offscreen keyboard/nested reorder/native reopen pass |
| Fourteen workspaces visited twice         | Renderer 23.4 → 23.7 MiB; main 80.1 → 58.8 MiB within gate; one row at each pass endpoint                                            |
| Search, mutations, dormant histories      | Search 8.1–52.5 ms; search gap 16.8 ms; rename/delete/eviction/hidden-workspace restore pass                                         |

Long-tool opens include the actual row rename window and are not comparable directly with public-action
timings. Workspace scale uses one local fake-provider activity probe and no Engine 2 provider request.

```text
npm run typecheck                                     [node + web, exit 0]
npm run build
✓ built in 18.15s
npm run checks
✓ all checks passed
npx prettier --check src/renderer/features/chat/Transcript.tsx scripts/qa/chat/transcript-scroll.qa.mjs
All matched files use Prettier code style!
node scripts/qa/chat/transcript-scroll.qa.mjs
✓ chat-transcript-scroll passed (67.1s)
node scripts/qa/chat/transcript-activation.qa.mjs
✓ chat-transcript-activation passed (7.4s)
node scripts/qa/sessions/open-feedback.qa.mjs
✓ sessions-open-feedback passed (17.9s)
node scripts/qa/performance/long-tools.qa.mjs
✓ performance-long-tools passed (12.9s)
node scripts/qa/performance/prime-long-history.qa.mjs
✓ native Prime long history: 3000 tools; 12 timing gates passed
node scripts/qa/performance/workspace-scale.qa.mjs
Failures: 0
✓ performance-workspace-scale completed
```

## Identity, reproduction, and artifacts

Measured product source: `f35781f987ec22bbecf005a13121e2cc7541b323`. SHA-256:

| Artifact                 | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| Baseline main output     | `1ab2889e9e77198d5981c21992f6130f0d3c028fb10cdea958978f5208200e4b` |
| Baseline renderer index  | `150033f4cd0b20313b800e84b3cada2ab20eb81cb112c1c22af3053eb0f94890` |
| Candidate main output    | `0104cf3d8900a29caf85270d6d23a56d35d5f21e1fa71cdf116a0c55897a668b` |
| Candidate renderer index | `facedcab9f2b1f9f9065b08cbcfe42d05097c31f8c6480798d6f61eff8ad1564` |
| Engine `.2` payload      | `97f796c58c176d6f78f1bbb45564c26225d53826bcb34b479865900002d18a39` |
| Engine 2 `.10` payload   | `b743f51df4f9ab40c1b697539d6765cd88a19da1aaf8df3e7ee28b122c321768` |
| Engine 2 `.11` payload   | `64f695dd72aa9ddad9a41b3e70344522512c50654c89a2d78a6164ff14f654b2` |
| Candidate native helper  | `1de7bea53c7f128ba5e7801e5570ac3b34e996475b1069a13f8a4b471df6774f` |

Engine upstream revisions: `71023aec1546d6d677a65669c5665c0927ce0dd0` and
`763094e1b6a7c17450ee8399b06cda1853847ca5`. Helper receipt fingerprint:
`3e3b05f12545b8099352dcf2a36316f3240932eb36ee7422296a920111a40847`.

```bash
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts \
  node scripts/perf/first-navigation.mjs --label paired-scroll-final --runs 3 \
  --engines-root D:/Coding/vengeance/.engine-staging/bundled
QA_TMP_ROOT=D:/Coding/vengeance-qa-engine-prompts \
  node scripts/perf/first-navigation.mjs --label bundled-scroll-final --runs 3
```

Build the desired revision first; use fresh labels to retain evidence. Baseline used retained output,
the same visible endpoint/`.10` payloads, and only `--record-scroll-failures`. Reversible rename/copy
restored final output with hash verification. No swaps occurred during candidate runs. The harness
rejects executable overrides, verifies descriptors/entry hashes, waits for owned seed workers to exit,
and cleans temporary profiles/accounts/daemons through nested `finally` paths. At the end of these scale
runs, only the pre-existing user daemon PID 28900 remained; it was untouched.

Repository-relative evidence:

- `.shots/perf/first-navigation/{baseline-visible,paired-scroll-final,bundled-scroll-final}.json`,
  per-sample PNGs/CPU profiles: raw samples, IPC, workers, paints, identity/scroll checks, flags/hashes.
- `.shots/qa-scroll-final/performance-shots/long-tools-metrics.json` (copied with PNGs from the canonical
  `.shots/qa/performance-shots/` immediately after its final run).
- `.shots/qa-scroll-final/prime-long-history-shots/report.json`.
- `.shots/qa-scroll-final/workspace-scale-shots/final-report.json` (`focused: false`, `baseline: false`).
- `.shots/qa-scroll-final-feedback/open-feedback-shots/{metrics.json,opening-session-feedback.png}`.
- `.cache/performance-{paired-scroll-final,bundled-scroll-final,long-tools-scroll-final,prime-history-scroll-final,workspace-scale-scroll-final}.log`.
- `.cache/{typecheck,checks}-scroll-event-only.log`, `.cache/qa-scroll-event-only-final-exact.log`,
  `.cache/qa-scroll-event-only-threshold.log`, and `.cache/qa-scroll-final-feedback.log`.
- `.cache/checks-catalog-timer-before.log`, `.cache/checks-catalog-reload-before.log`, and
  `.cache/checks-catalog-reload-final.log` retain failing public regressions and passing checks.

Inspected PNGs include first Engine/Engine 2 samples from both candidate timing series;
`long-tools-10000.png`; native cold/resident/cached and released history; workspace primary,
all-expanded and dormant-renamed; and final opening feedback.
Navigation captures show real colors, exact marker at bottom, and no Jump pill. Baseline scroll
failure captures show blank virtual history.

Historical `baseline.json`, `paired-final-verified.json`, `bundled-final.json`, intermediate
`paired-visible-final.json` / `bundled-visible-final.json`, and the `7214218` candidate's
`paired-ready-final.json` / `bundled-ready-final.json` remain ignored artifacts. Mounted or
pre-readiness results are not substituted into these visible-marker tables. Failed setup and
diagnostic runs are excluded. Evidence is ignored by Git and can be regenerated.
