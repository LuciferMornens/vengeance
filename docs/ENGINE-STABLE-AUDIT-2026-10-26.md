# Engine stable audit — 26 October 2026

Both engines move to their newest stable releases. The release APIs and remote tags were checked on
26 October 2026; Prime's newer `v0.10.2-beta.*` tags and `nightly` are prereleases and were not adopted.

## Release identity

| Engine      | Latest stable | Published UTC             | Exact upstream commit                      | Vengeance build      |
| ----------- | ------------- | ------------------------- | ------------------------------------------ | -------------------- |
| pi          | `v1.4.0`      | 21 October 2026, 22:49:48 | `4a080252f06caf63a525d7873c5d94d3c23887e0` | `1.4.0+vengeance.1`  |
| Prime Agent | `v0.10.1`     | 21 October 2026, 23:33:59 | `8aac8692456c00c01d4e53e60e6d3347a3506559` | `0.10.1+vengeance.1` |

pi's tag points directly at its commit; Prime's annotated tag `0d457e8e` peels to its commit. Prime's
model catalog stays at `b90e08807c37ccdfab04eb31b23de6a86dd6e7fe`. The helper links the same patched
Prime revision.

Sources: [pi release](https://github.com/earendil-works/pi/releases/tag/v1.4.0) and
[Prime release](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.10.1).

## pi 1.4.0

All nine patches carry over; see the [pi patch guide](../patches/pi/README.md). Two conflicts needed
review: the chord package-boundary test and the default-model table. Patch `0006` now lists all four
Abliteration models, adding Abliterated Large Flash and the full effort ladder on Abliterated Large.
Patch `0005` makes upstream's `check:entry-graphs` compare `/` paths on Windows, and `0010` raises the
`./models` budget by the one file it adds. Every internal `dist/` module the app imports still exists.

`node scripts/checks/pi-workspace.mjs check` passes. The full isolated suite passes except eight
classifier tests (`classifier-models`, `cloudflare-workers-ai-system-one`, `model-runtime-classifiers`):
the catalog pinned by the 1.4.0 commit (`sha256-7fe1b41f…`) lacks Workers AI's `@cf/cloudflare/clef-omni`
and image input for `typesafe/jev-latest`, which the same release's tests expect. Unpatched `v1.4.0`
with that catalog fails the same eight tests through the isolated harness. No patch touches
classifier models or their data; the pinned catalog is not edited to satisfy a test. Vengeance does not
use classifier models. `scripts/qa/auth/abliteration.qa.mjs` passes against the built Engine.

Kimi K3.1 Pro and K3.1 Pro Highspeed are absent from the pinned catalog
([pi#11400](https://github.com/earendil-works/pi/issues/11400)); the native catalog refresh supplies them
with Kimi Code's `low`, `high` and `max` efforts. On 26 October, Kimi Code answered every K3.1 Pro
Highspeed request with `429 engine_overloaded_error` for an account with nearly all of its plan quota
left, including minimal requests without Engine involvement, while K3.1 Pro answered at every effort.
About three hours later the staged Engine answered on K3.1 Pro Highspeed at `low`, `high` and `max`
(`--no-session`, temporary folder), so the overload was transient on Kimi's side. The built app in
the QA harness's real mode, with each model picked in the composer footer, then answered on K3.1 Pro
Highspeed and K3.1 Pro at `low`, `high` and `max`. The app now reads
that error as the provider's overload rather than the account's rate limit.

## Prime 0.10.1

The series shrinks from 24 to 21 patches; see the [Prime patch guide](../patches/prime-agent/README.md)
for each decision. Upstream now ships `0014`, `0017` and `0022`; `0001`'s runtime fix is upstream and only
its regression test remains. Rebasing `0007` exposed a regression on the new base: one listening
named-pipe instance made quick reconnects wait on "pipe busy", so `rlm_children::watch_tests` timed out.
The patch now keeps two instances listening.

Upstream `3e08932` renamed the model's Python tool from `ipython` to `python_repl`; saved calls under
the old name still dispatch through its alias. The app's fallback tool listing asks for `python_repl`, and
the QA suites that look up the declared tool accept either name (`PYTHON_TOOLS` in
`scripts/qa/lib/native-kernel.mjs`). The 14 October audit had flagged this contract change.

The full isolated native workspace ran 4,862 passing tests with 16 failures, and clippy with
`-D warnings` passes. Twelve failures needed the packaged kernel's Python; with
`--with-kernel`, `print_inline_subagents_e2e` passes 11/11 and `rpc_mode_e2e` 21/21. The other
four: three `pa-perf` failures also fail on unpatched `v0.10.1`; one ACP fixture exceeded its cleanup bound
under full-suite load and passes 44/44 alone. The 15 app QA suites, including dual-engine integration,
MCP live status, restart safety and native compaction, pass with fake providers. On Windows x64,
`scripts/qa/engines/packaged.qa.mjs` passes against the `npm run dist:qa -- --dir` package: both bundled
engines stream from it and its helper and Engine 2 sign-in load. Other platforms are not qualified here.
