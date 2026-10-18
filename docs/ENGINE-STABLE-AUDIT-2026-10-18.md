# Engine stable audit — 18 October 2026

Both bundled engines already use the latest official stable release. The release APIs and all
remote tags were checked at 20:03 UTC on 18 October 2026. No upstream revision, build identity,
patch list, catalog pin or helper dependency changes are needed for a stable upgrade.

## Release identity

| Engine      | Latest stable | Published UTC             | Exact upstream commit                      | Vengeance build       |
| ----------- | ------------- | ------------------------- | ------------------------------------------ | --------------------- |
| pi          | `v1.3.0`      | 15 October 2026, 19:17:33 | `71023aec1546d6d677a65669c5665c0927ce0dd0` | `1.3.0+vengeance.2`   |
| Prime Agent | `v0.10.0`     | 9 October 2026, 21:28:57  | `763094e1b6a7c17450ee8399b06cda1853847ca5` | `0.10.0+vengeance.10` |

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
stays retired; the active seven-patch series and Prime's nineteen-patch series are unchanged.
The helper stays linked to the same reviewed patched Prime source and revision.

Development source was checked to identify future reconciliation work, without adopting it:

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

## Qualification scope

This was a read-only release and source audit. No engine checkout, native build, account write,
provider request, migration or runtime qualification was performed. It does not replace the
existing release evidence or qualify an unreleased upstream head.

A future stable candidate requires the complete procedure in [UPSTREAM.md](../UPSTREAM.md): run
each local regression on unpatched upstream, retire only demonstrated superseded fixes, port and
reconstruct the remaining series, review SDK and helper contracts, then qualify native workspaces,
app integration, prompts/model changes, restart and resident lifecycle, saved history, executable
transition and packaged runtime loading. Retain a complete working package and isolated recovery
copies. Each platform needs its own evidence; Windows results do not qualify macOS or Linux.
