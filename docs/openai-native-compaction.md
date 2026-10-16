# OpenAI native compaction

## Incident and correction

The old Engine bridge requested a checkpoint by adding a user turn ending in “Reply with OK only.”
It then replaced the engine's text summary with the opaque result. The reported session later ended
normally with `OK`, despite having a report outstanding. The injected instruction is the leading
explanation; the encrypted contents cannot be inspected to prove what the model retained.

Both engines now append the protocol item `{"type":"compaction_trigger"}` to the history being
replaced. They preserve the original system instructions and active tool schemas, use the selected
model's authenticated transport, and use provider defaults for reasoning and sampling without an
answer-token budget. This also avoids an unsupported `reasoning.effort: none` default.
No fabricated user turn enters the checkpoint. The engines retain their ordinary text summaries.

## OpenAI and Codex study

OpenAI documents two API mechanisms: automatic compaction using `context_management`, and the standalone
`/responses/compact` endpoint. Both return opaque state. The standalone endpoint returns an entire
replacement window, potentially including retained messages; extracting just its encrypted item would
lose part of that window. [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction).

The current public Codex implementation also has streamed remote compaction v2. At researched revision
`e89b7c442c0433ad5167e72a5a25bb6d0712766a`, it appends `CompactionTrigger` to the Responses input,
keeps the task's base instructions and tools, and accepts exactly one compaction item only after a
completed response. It then installs that item with the context its own history policy retains.
See [request preparation](https://github.com/openai/codex/blob/e89b7c442c0433ad5167e72a5a25bb6d0712766a/codex-rs/core/src/compact_remote_v2_attempt.rs)
and [stream validation and installation](https://github.com/openai/codex/blob/e89b7c442c0433ad5167e72a5a25bb6d0712766a/codex-rs/core/src/compact_remote_v2.rs).

The desktop-facing app-server delegates `thread/compact/start` to the shared core's `Op::Compact`;
the UI receives compaction lifecycle notifications. This is core functionality shared with CLI
clients, rather than a desktop-only summarization prompt. The public source establishes that design;
it does not establish which feature rollout every installed desktop binary uses.
[App-server protocol](https://developers.openai.com/codex/app-server),
[core dispatch](https://github.com/openai/codex/blob/e89b7c442c0433ad5167e72a5a25bb6d0712766a/codex-rs/app-server/src/request_processors/thread_processor.rs).

Vengeance uses the streamed trigger protocol, verified against the live Responses API. Its engines
continue to decide their own compaction boundaries. This is separate from the standalone endpoint's
whole-window contract and does not discard any output from that endpoint.

## Persistence and recovery

- Checkpoints require format `responses-compaction-trigger-v1` and matching model, provider, API and
  configured endpoint. Other models and endpoints receive the portable text summary.
- Unversioned Engine checkpoints are ignored, including those already saved in existing chats. Their
  records are preserved unchanged. No migration rewrites the user's sessions or encrypted contents.
- Engine checkpoints are custom entries tied to the latest compaction on the active branch. Shutdown,
  navigation, failed compaction and abort cancel pending work. Extension-owned compactions keep their
  own result.
- Engine 2 stores the checkpoint in the compaction entry's `details.nativeCompaction`. Its context
  rebuild carries this through a typed optional field. At provider conversion, a user text signature
  transports the metadata across the agent loop; unrelated providers see ordinary summary text.
  The harness digest remains visible beside the native item.
- Only a successfully completed stream with exactly one nonempty encrypted item qualifies. Missing,
  malformed, duplicate, incomplete, failed or cancelled results cannot replace the text summary.
- Engine 2 captures the exact replaced prefix, including tool results and any previous checkpoint.
  Its existing branch-conflict check controls the atomic commit. Summary failure drops the native
  future and cancels its transport. Native usage is added to the compaction's billed usage.
- Disabling the preference leaves text compaction available. The setting takes effect when sessions
  start or restart. OpenAI Chat Completions and non-OpenAI providers keep ordinary text compaction.

## Qualification

`scripts/qa/engines/native-compaction.qa.mjs` drives both bundled engines through the app with isolated
API-key and OAuth fixtures. A tool reads operands, an injected overflow forces native compaction,
and the resumed loop must write the result and report it without another user message. The suite
also checks reload, repeated compaction, legacy checkpoint recovery, invalid responses and transport
cancellation. `scripts/qa/chat/native-compaction.qa.mjs` covers model switches and the preference.

`scripts/qa/engines/native-compaction-live-run.mjs` is an explicitly invoked live counterpart. Its JSON
configuration arrives on stdin, keeping credentials out of command arguments. A local proxy forwards
real model requests and injects one overflow after a real tool call, while file work is still pending.
It bounds requests, prompt size and observed tokens. Success requires a real checkpoint, subsequent
native replay, the completed file and the model's report. Subscription access is resolved by the native
read-only credential store; refresh and writes are disabled. All engine state remains in temporary roots.
The proxy decodes native request compression, refuses WebSocket negotiation to exercise the native SSE
fallback, and records usage on `response.completed` because clients may close before stream EOF.

The native patch includes stream-validation and route-identity regressions. Run the focused `pa-core`
compaction tests, `pa-ai` tests, formatting and clippy in addition to the app gates. Patch `0015` must
be exported and reconstructed through `engines.lock.json`; staged binaries are never edited.

### Results, 2026-10-15

Live GPT-6.1 Sol tests crossed an injected overflow after reading `operands.txt`, before `result.txt`
existed. Each resumed request contained the real opaque checkpoint, wrote `323` to the file, and
reported the result without another user message:

| Engine   | Authentication           | Live result                           |
| -------- | ------------------------ | ------------------------------------- |
| Engine   | OpenAI API key           | `17 × 19 = 323. Saved to result.txt.` |
| Engine 2 | OpenAI API key           | `17 × 19 = 323. Saved to result.txt.` |
| Engine   | ChatGPT, Codex Responses | `17 × 19 = 323. Saved to result.txt.` |
| Engine 2 | ChatGPT, Codex Responses | `17 × 19 = 323. Saved to result.txt.` |

The Engine's direct `openai` OAuth access token expired before its live run. At the user's direction,
the subscription checks used the available Codex credential through the read-only native credential
API. Direct OAuth was covered by the isolated app fixture, not a successful live call. Live WebSocket
forwarding was not tested; these live runs cover SSE and native WebSocket-to-SSE fallback.

The five-route app matrix passed task continuation, reporting, reload, repeated compaction, invalid
responses and cancellation after the text summary finished. Engine routes also passed recovery from
an unversioned checkpoint without rewriting its record. The separate chat suite passed model changes,
non-OpenAI fallback and the preference. The `.5` to `.6` executable-transition suite passed all three
checks, preserving session identity, history and selected model/reasoning state.

`npm run typecheck`, `npm run checks`, and `npm run build` passed. Prettier passed on all changed
TypeScript, JavaScript and JSON files. The full `npm run shots` run completed 16 of 17 scenario files;
`session-close` timed out waiting for a hover tooltip, then passed all five screenshots when rerun
with `npm run shots -- session-close`. The intentional malformed-frame warning in transcript recovery
is asserted by that scenario. Live task reports, subscription settings, session-close and transcript
recovery PNGs were inspected.

`npm run dist:qa -- --dir` built the unpacked QA app. With `QA_PACKAGED_EXE` pointing at that app and
`QA_TMP_ROOT` outside the repository and user home, `scripts/qa/engines/packaged.qa.mjs` passed both
engines, external bridge loading, helper loading with a system-only PATH, and the public sign-in
flow cancelled before entering a key. The packaged engine PNGs were inspected.

Native formatting and workspace clippy passed. The broad workspace test attempt stalled in
`pa-daemon::worker::turn_stream_tests::broadcast::a_retried_turn_broadcasts_one_agent_end_per_run`.
That test passed in its own process; the remaining daemon unit tests passed (905 passed, 8 ignored).
The same test also stalled late in a serial combined run, so this is a test-order limitation, not a
clean full-workspace test result. The daemon crate's integration tests also passed with that one unit
test excluded. Other completed workspace and remaining-crate runs passed. Native runners verified
both real account configurations remained unchanged.

Representative final command output:

```text
npm run build (also run by dist:qa)
✓ built in 17.82s

npx prettier --check <changed TypeScript, JavaScript and JSON files>
All matched files use Prettier code style!

node scripts/qa/engines/native-compaction.qa.mjs
✓ task continuation, report, reload, repeated compaction, fallback and cancellation
(all five routes)

node scripts/qa/chat/native-compaction.qa.mjs
✓ chat-native-compaction passed (10.7s)

node scripts/qa/engines/candidate-transition.qa.mjs
✓ Official-to-candidate native restart: 3 checks passed

node scripts/qa/engines/packaged.qa.mjs
✓ packaged-engines passed
```

The final live Engine/Codex rerun recorded five completed model calls and 6,329 total tokens across
those calls, including the parallel text summary and native checkpoint. Its final report was
`17 × 19 = 323. Saved to result.txt.` This token count covers that run, not all qualification work.

Reconstructed artifact identities:

- Prime base: `763094e1b6a7c17450ee8399b06cda1853847ca5`, Vengeance `0.10.0+vengeance.6`.
- Patch `0015` SHA-256: `67c23b1aeaad59ccc83df5fcd86e961e7e3cf5c776239cad7947809b06d64454`.
- Candidate executable SHA-256: `569b361715db000db67821b41756d50d4ea200fe890e2f57919c012ad4eb1048`.
- Retained `.5` baseline SHA-256: `527867a1edb67d2774f64882d5ae12a7a0aafb560e3cc8d768634da026e9b7a5`.
