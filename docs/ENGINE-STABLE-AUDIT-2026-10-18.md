# Engine stable audit — 18 October 2026

Both bundled engines already use the latest official stable release. The release APIs and all
remote tags were checked at 20:03 UTC on 18 October 2026. There is no newer stable base to adopt.
Separate native prompt qualification found a stable-base defect requiring the local Prime
backport described below; its build identity changes while the upstream revision stays pinned.

## Release identity

| Engine      | Latest stable | Published UTC             | Exact upstream commit                      | Vengeance build       |
| ----------- | ------------- | ------------------------- | ------------------------------------------ | --------------------- |
| pi          | `v1.3.0`      | 15 October 2026, 19:17:33 | `71023aec1546d6d677a65669c5665c0927ce0dd0` | `1.3.0+vengeance.2`   |
| Prime Agent | `v0.10.0`     | 9 October 2026, 21:28:57  | `763094e1b6a7c17450ee8399b06cda1853847ca5` | `0.10.0+vengeance.11` |

The Vengeance identities above are the current lock entries. Prime's complete 22-patch series has
been reconstructed and its native checks passed; engine/helper builds and app qualification remain.

The official GitHub `releases/latest` responses identify these releases as non-prereleases.
Independent `git ls-remote --tags` checks, sorting numbered stable tags as versions, find the
same newest stable tags. pi's tag points directly to its locked commit. Prime's annotated tag
`8de18adda5d6fdea3dc31843d5955d311c92cb9e` peels to its locked commit.

Sources: [pi release](https://github.com/earendil-works/pi/releases/tag/v1.3.0),
[pi release API](https://api.github.com/repos/earendil-works/pi/releases/latest),
[pi tag API](https://api.github.com/repos/earendil-works/pi/git/ref/tags/v1.3.0),
[Prime release](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.10.0),
[Prime release API](https://api.github.com/repos/PrimeIntellect-ai/prime-agent/releases/latest), and
[Prime annotated tag API](https://api.github.com/repos/PrimeIntellect-ai/prime-agent/git/tags/8de18adda5d6fdea3dc31843d5955d311c92cb9e).

Prime has newer prerelease tags, through `v0.10.1-beta.35`, whose peeled commit is
`eb11e0c7a0ee24287ec1e61cfc885699cd5c234a`. Its moving `nightly` release is also marked as a
prerelease. Neither is a stable-upgrade candidate.

## Relevant contracts and patch decisions

The latest pi release already includes prompt-template empty-argument fixes, active-tool restoration
on resume, model-switch reasoning cleanup and selectable native share destinations. These are
features of the locked base. Prime publishes no release-note body for `v0.10.0`; its exact source
and the prior [stable audit](PRIME-STABLE-AUDIT-2026-10-16.md) remain the review boundary.
There is no new stable source or session-format transition to qualify in this audit.

Every active source patch remains listed in [the engine lock](../engines.lock.json). An unchanged
upstream base supplies no new evidence for retiring a patch. pi's historical catalog patch `0004`
stays retired; its active seven-patch series and Prime's first nineteen patches are unchanged.
Prime patch `0020` extends runtime behavior, and test-only qualification patches `0021` and `0022`
bring the ordered series to 22 patches. The helper keeps the same upstream revision and protocol;
its changed engine inputs require a rebuild and qualification against the final patched source.

Development source was checked without changing the stable base:

- pi `main` was `482c1381a00d8d00bc81697e4a980c593db6803e`, 30 commits after stable. Relevant
  changes include summary output limits, provider retry behavior and model configuration defaults.
  The public coding-agent RPC, session writer and native sharing implementation are absent from
  that comparison's changed-file list. This is source-review evidence, not compatibility qualification.
- Prime `main` and `nightly` were `7cbffa77b38facd7c87277fa3c82bcadbe816880`, twelve commits
  after the 16 October audit's reviewed head. New work touches worker-exit sidecars, ledger caching,
  dead-child deletion, kernel bootstrap sources and MCP OAuth configuration. These boundaries need
  lifecycle, saved-history, performance and helper coverage when a stable successor includes them.
- Prime patch `0001` has an upstream cancellation counterpart; `0014` and `0017` are identified
  upstream backports. Their regressions must pass on an unpatched stable successor before retirement.
  Patch `0012` has only partial upstream overlap: updated kernel facts do not establish generated
  prompt refresh. The prior audit records the remaining patch-by-patch boundaries.
- Prime's new ledger cache changes `LivePathResolver` to return `Result` and share an artifact index
  through the replay state. Future porting of `0016` must reconcile those APIs and requalify read-only
  observation, endpoint resolution and tombstones. Cache improvements alone do not replace its
  nonmigration contract.

Sources: [pi comparison](https://github.com/earendil-works/pi/compare/71023aec1546d6d677a65669c5665c0927ce0dd0...482c1381a00d8d00bc81697e4a980c593db6803e),
[Prime comparison since the prior audit](https://github.com/PrimeIntellect-ai/prime-agent/compare/a01c7923cfcb8d130b50d24332db1413b0e7479c...7cbffa77b38facd7c87277fa3c82bcadbe816880),
[worker-exit sidecars](https://github.com/PrimeIntellect-ai/prime-agent/commit/823904967e9187765847ebadedf6dec456cfb2fe), and
[ledger replay caches](https://github.com/PrimeIntellect-ai/prime-agent/commit/b9c1c2ffbf767bee61b28905ac275692f200c1b7).

## Stable-base appended prompt backport

Actual provider QA found that Prime `v0.10.0` discovers `APPEND_SYSTEM.md` but omits its resolved
content when assembling a session's prompt. Patch
[`0020-native-append-system-prompt.patch`](../patches/prime-agent/0020-native-append-system-prompt.patch)
adapts upstream commit
[`b1d71636710b0ea1b86380dfe3923b3c03fe2948`](https://github.com/PrimeIntellect-ai/prime-agent/commit/b1d71636710b0ea1b86380dfe3923b3c03fe2948).
It sends explicit append sources through the native resource loader and puts the resolved raw text
in the builder's appended-prompt segment. The stable builder's separate generic-guidelines API
remains available. An additional CLI diagnostic hunk includes the same appended text in native
`prompt` output; the reviewed upstream development head still omits it there.

Native precedence remains explicit append sources, otherwise the project file, otherwise the global
file. SYSTEM and APPEND selection are independent. An empty project or explicit append suppresses
fallback; whitespace, Markdown and repeated bullets remain raw text. The appendix follows the native
dynamic tail and survives live model changes. The patch changes neither the daemon JSON contract nor
saved-session format, credential storage or helper protocol. Its SHA-256 is
`0db58a84c6f8b771041c43d62d8e4e26067ec027e8ae4703c1f6e5f8ddfcd5f7`.

The exported patch was reviewed against the authoring source: three files, 223 additions and four
deletions. The source owner reports eight focused actual-provider unit tests passing, covering
independent scope precedence, explicit literal/file sources, empty and whitespace overrides,
default/custom foundations and model-switch retention. All four focused CLI prompt-command tests
also pass, including the raw appendix diagnostic. Final reconstructed engine, helper and app
qualification is pending at this point. These focused results do not establish release compatibility.

Retire the core backport only after an unpatched stable successor passes those provider regressions
and its public API changes are reviewed. Recheck the separate native CLI diagnostic hunk before
retiring the whole patch. Running residents keep their current prompt until an explicit guarded
restart; a successful native `reload` response does not rebuild their prompt.

## Native qualification fixture corrections

The initial full native attempt exposed two fixture failures. The refinement concurrency case failed
with a held-lock error; five subsequent isolated runs reproduced it. Separately, ACP's
`acp_daemon_attached_eof_during_session_new_exits` reached its successful EOF-exit assertion but then
hung during fixture teardown. A debugger found the test joining a stderr reader whose pipe still had
inherited Windows writers. Stopping the identified temporary daemon tree released that join. This
intervention makes the initial run unsuitable as a clean qualification result.

[`0021-acp-fixture-cleanup.patch`](../patches/prime-agent/0021-acp-fixture-cleanup.patch) is a local
test-only correction. Anonymous-file stderr retains diagnostics without depending on inherited pipe
EOF. Cleanup uses bounded child waiting and an asynchronous native shutdown request, requiring its
acknowledgement, connection closure and supervisor exit. Failures remain visible without double panic
during an existing assertion unwind. The session creation and successful ACP-exit assertions stay
intact. Retire it only after the equivalent upstream fixture repeatedly passes on Windows without
orphan processes or external cleanup, together with the complete native suite.

[`0022-upstream-harness-lock-fixture.patch`](../patches/prime-agent/0022-upstream-harness-lock-fixture.patch)
backports only the refinement-test hunk from upstream
[`f0d9c09676a1e6bb2782ad73eb3025ffdf2061d4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/f0d9c09676a1e6bb2782ad73eb3025ffdf2061d4).
The native lock has an intentional bounded wait and does not guarantee writer fairness. The stable
fixture repeatedly reacquired it until other writers exhausted that budget. Upstream instead races
two fresh writers in 40 rounds and still checks
all 80 updates. Runtime locking and timeouts stay unchanged; the unrelated upstream abort-test hunk is
excluded. Retirement requires that correction in a stable base, repeated isolated passes and a clean
full native run.

Patch SHA-256 values are `3ec4e10dd800cd438de6af187272564c5445b3ff48460a54c19ee37a6314464c`
for `0021` and `51d3e0483882c6abd4aa58d45fd2d0e474395a743eb4a8ab5450c332da855566` for `0022`.
The final source is `prime-763094e1-fc924d12`; its receipt records patch hash
`fc924d1298f41b9715c9b69f8fe0622e1f132e3b24b47f2ff9c339f3847212f7` and source hash
`29fae788e3271b41e2399ffc28029316b8a93bd10659d2a0544c57f34550e5a1`.
Its engine input fingerprint is
`ddc7335e5f42fad308e6f5465e2497cfa07bc3d8686f816150bcaedd9e37135f`.

The clean reconstructed native run, with debug symbols disabled, four test threads and an isolated
kernel, completed 4,477 passing tests and 14 ignored tests across 216 suites. Formatting checked all
nine packages and 211 targets. The subsequent Clippy run found one test-only `if_not_else` issue in
the new append fixture. The branch was inverted without changing its assertions, then patch `0020`
was re-exported against the first nineteen patches and the complete series reconstructed again.
The three append-related files and both qualification-fixture files match the authoring source
byte-for-byte; `0021` and `0022` patch bytes are unchanged. All eight append tests pass after the style
correction. Final full-workspace, all-target Clippy passed with `-D warnings` in 23.99 seconds.
The retained full test log is `.cache/prime-workspace-clean.log`; the focused rerun is
`.cache/prime-append-style-final.log`, and Clippy is `.cache/prime-clippy-style-final.log`.
Both isolated account guards passed. These native results do not qualify final app packages or
another platform.

## Qualification scope

The initial release audit and independent patch review were read-only. Later native fixture work and
the focused test and Clippy reruns are recorded separately above. Those isolated checks passed both
real-account guards. They do not establish final release qualification or qualify an unreleased
upstream head.

The reconstructed series needs an engine/helper rebuild, the applicable app/native integration
regressions and the public app provider test in
`scripts/qa/settings/system-prompts.qa.mjs`. Verify a real saved-worker PID transition, held-stream
save behavior, model-switch retention, mixed-version resident notices and the helper's static-only
default foundation. Repeat the applicable restart, image-capability, bundled-identity, packaged
runtime and app validation gates in [UPSTREAM.md](../UPSTREAM.md), then inspect their screenshots.

A future stable candidate requires the complete procedure in [UPSTREAM.md](../UPSTREAM.md): run
each local regression on unpatched upstream, retire only demonstrated superseded fixes, port and
reconstruct the remaining series, review SDK and helper contracts, then qualify native workspaces,
app integration, prompts/model changes, restart and resident lifecycle, saved history, executable
transition and packaged runtime loading. Retain a complete working package and isolated recovery
copies. Each platform needs its own evidence; Windows results do not qualify macOS or Linux.
