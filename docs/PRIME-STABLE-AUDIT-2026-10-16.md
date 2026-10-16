# Prime stable audit — 16 October 2026

Engine 2 remains based on official stable `v0.10.0`, commit
`763094e1b6a7c17450ee8399b06cda1853847ca5`. The Vengeance build is
`0.10.0+vengeance.8`; the ordered patches and exact inputs are in
[engines.lock.json](../engines.lock.json). No nightly or beta base was adopted.

## Upstream identity

The official public releases API and all remote tags were checked on 16 October.
The latest stable release is still `v0.10.0`, published 9 October at 21:28:57 UTC.
Its annotated tag `8de18adda5d6fdea3dc31843d5955d311c92cb9e` peels to the locked commit.
The latest numbered prerelease is `v0.10.1-beta.32`, peeled commit
`3195ffc87987c45925108e6acf3b82d991839bb4`. The reviewed `main` and `nightly` commit is
`a01c7923cfcb8d130b50d24332db1413b0e7479c`, 84 commits after stable.

Sources: [official releases](https://github.com/PrimeIntellect-ai/prime-agent/releases),
[stable release](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.10.0),
[reviewed comparison](https://github.com/PrimeIntellect-ai/prime-agent/compare/763094e1b6a7c17450ee8399b06cda1853847ca5...a01c7923cfcb8d130b50d24332db1413b0e7479c).

## Local patches and future retirement

All existing patches remain necessary on the unchanged stable base. Reviewing development source
identifies candidates for future qualification; it does not qualify that development build.

| Patch | Behavior and regression boundary                                                                                                                   | Reviewed development source                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001  | Compaction HTTP cancellation, including split summaries; `compaction_http_abort` and app Stop/compaction QA.                                       | Incorporated by `7e86390` at the same cancellation-token/drop-guard boundary. Retire after both local scenarios pass on a stable successor. |
| 0002  | Durable user-shell output reaches live provider context; replacement and compaction races; native `user_bash` context tests and app bash/queue QA. | Still needed. `53e13b8` improves process admission/settling but only persists shell results; it does not ingest them into a cached agent.   |
| 0003  | Portable Windows release archive paths; native packaging dry run.                                                                                  | Packer unchanged after stable.                                                                                                              |
| 0004  | Vengeance identity and independent native update refusal; bundled-engine and updates checks.                                                       | Distribution policy remains local.                                                                                                          |
| 0005  | Fast/Ultrafast transport, entitlement, cache isolation and cancellation; native service-tier and app speed matrices.                               | No upstream Ultrafast implementation found.                                                                                                 |
| 0006  | Windows cache certification, durable appends and canonical leases; `windows_session_window` and `session_lease_paths`.                             | Still needed. Review child-usage/session changes during rebasing.                                                                           |
| 0007  | Fragmented daemon commands and named-pipe cancellation; native ACP and Windows transport regressions.                                              | Still needed. New client-write cleanup touches the supervisor boundary.                                                                     |
| 0008  | Portable, isolated Windows native fixtures; native workspace suite.                                                                                | Reconcile each hunk: upstream removes the golden prompt test and revises several fixtures, including abort readiness.                       |
| 0009  | Windows npm launcher resolution; native package launcher regression.                                                                               | Source unchanged after stable.                                                                                                              |
| 0010  | Useful Windows edit errors; `windows_edit_tool`.                                                                                                   | Source unchanged after stable.                                                                                                              |
| 0011  | Windows incident-log file identity/rotation; native incident notice regressions.                                                                   | Source unchanged after stable.                                                                                                              |
| 0012  | Atomic model/thinking/prompt refresh and kernel image facts; native model tests and app image-capability QA.                                       | Partial overlap with `c69d921`: kernel facts and failover update upstream, but generated prompt refresh remains distinct.                   |
| 0013  | Per-session creation-model isolation; native `model_isolation` and app parent/child model QA.                                                      | Still absent: `creation_model()` reads shared defaults without latching the selection.                                                      |
| 0014  | Concurrent/unknown settings and MCP preservation; native persistence and MCP save tests.                                                           | Exact upstream backport from `7b89c11`, with its service-tier hunk adapted to local Ultrafast.                                              |
| 0015  | Native OpenAI compaction checkpoints, route identity, replay and cancellation; native tests and app compaction matrices.                           | No corresponding upstream implementation found.                                                                                             |
| 0016  | Read-only ledger observation, atomic topology/tombstone snapshot and orphan/moved endpoints; native `read_only_roster` and helper lineage tests.   | Local integration boundary. Native ledger reads otherwise may migrate a missing legacy ledger.                                              |
| 0017  | rustls 0.23.46 maintenance in native and helper lockfiles.                                                                                         | Lock-only backport from upstream `d4b36cc`; all other dependency versions/features stay pinned.                                             |
| 0018  | OAuth refresh flight covers credential persistence and reload; native paused-write regression plus duplicate-refresh and peer-write tests.         | Stable-base race confirmed during qualification; production lookup and failing test match unpatched stable. Requalify on each future base.  |
| 0019  | Deterministic coalescing ticks, queued goal-pause admission and telemetry retry-expiry tests.                                                      | Test-only qualification fixes for stable fixtures; no production coalescing, goal or retry behavior changes.                                |

Relevant source changes are
[compaction controls](https://github.com/PrimeIntellect-ai/prime-agent/commit/7e86390ea99550f04fc706fac54c8f9ce0161327),
[shell lifecycle](https://github.com/PrimeIntellect-ai/prime-agent/commit/53e13b89e14bf812c4635fdae4c42f9031c24167),
[model facts](https://github.com/PrimeIntellect-ai/prime-agent/commit/c69d921c4fcc46a5af58aa68b84cfb2c73332295),
and [settings preservation](https://github.com/PrimeIntellect-ai/prime-agent/commit/7b89c111da0f1d9e67849b34f10552bbb4bd1bd1).

Other development changes relevant to the next stable qualification include scoped parent-ledger reseeding
(`73acc534`), shared ledger replay/liveness (`b9b2ce83`), worker launch environments and stale `RLM_DEPTH`
removal (`e090862a`), durable child-usage attribution (`d592d5e`), queued agent-message abort recovery
(`7d191b47`), scoped daemon shutdown (`3407a54`) and attach transcript-tail/backfill (`9d6ca9a`).
These require native and app lifecycle tests before any backport or future stable adoption.

Patch 0017 carries rustls 0.23.46 maintenance from
[upstream `d4b36cc`](https://github.com/PrimeIntellect-ai/prime-agent/commit/d4b36cc27e039608ad1661186eec2d5e403807e4).
The helper locks the same crate. The current `ring,std,tls12` build does not enable Brotli, ECH or hybrid
post-quantum exchange and uses no custom TLS session-store Debug logging. The four advisories therefore
did not establish exposure in the prior package. This is stable dependency maintenance.
See the [rustls release](https://github.com/rustls/rustls/releases/tag/v%2F0.23.46) and
[RUSTSEC-2026-0346](https://rustsec.org/advisories/RUSTSEC-2026-0346.html),
[0347](https://rustsec.org/advisories/RUSTSEC-2026-0347.html),
[0348](https://rustsec.org/advisories/RUSTSEC-2026-0348.html),
[0349](https://rustsec.org/advisories/RUSTSEC-2026-0349.html).

## Helper and release qualification

All helper Cargo revisions, revision constants and app handshake consumers remain pinned to the stable
commit. The builder overrides native crates to the exact reconstructed patched engine source, fingerprints
those inputs and builds with `--locked`. The helper keeps protocol 1 and advertises its supported modes.
Neither a matching revision handshake nor a fresh binary hash proves compatibility with another engine.

Lineage discovery reads native ledger snapshots and bounded headers without starting a daemon, worker,
provider request or kernel. It does not migrate legacy registries. Artifact sessions require an admitted
native edge and a supported canonical path. Tombstones exclude their exact paths; duplicate header IDs
in independently imported files are not global deletion identities. Native forks can retain the same
depth as their source, so a `parentSession` header alone does not establish a spawned child.

Explicit offline child deletion acquires native parent and child leases before validating the ledger
edge and header identity. It captures native usage, keeps a recovery transcript, removes the selected
file and writes a native tombstone. Main moves the recovery transcript to the Recycle Bin. A failed
tombstone or recycle operation keeps the recovery path in the reported error. Resident parents use
their native child-deletion command and retain its running-child refusal.

Qualification exposed an upstream OAuth refresh race: the per-provider gate ended after the token
fetch, before the credential write. Two callers could fetch with the same single-use refresh token.
Patch 0018 holds that gate through persistence and reload while keeping HTTP outside the document
lock. A regression that pauses persistence failed on the unchanged stable lookup and passed with
the fix; all 16 auth-manager tests then passed, including the existing duplicate-refresh and concurrent
peer-writer tests. Both isolated account guards passed. These focused results do not replace the
combined native workspace and packaged release gates.

The same qualification run exposed wall-clock races in three unchanged stable fixtures: burst
coalescing assumed that 120 one-millisecond sleeps finished in 120 ms, goal pause could arrive
after its finite provider script completed, and telemetry expiry could be checked before its worker
processed a retry. Patch 0019 coordinates these tests using virtual timer ticks and native admission
barriers. It keeps the coalescing, queued-continuation withdrawal and retry-expiry contracts intact
without changing production behavior.

The combined run reproduced the historical retry-broadcast stall. Captured stacks placed the test
in Tokio runtime teardown, waiting for blocking subprocess pipe reads, after its async body finished.
Patch 0019 also gives that fixture an owned temporary workspace and orderly native worker shutdown.
The interrupted daemon target remains a failed qualification attempt until a complete rerun passes.
The helper's nine tests, formatting and strict Clippy passed against the preceding reconstructed source
`3038c8f7`; this final amendment changes only test fixtures. The release helper must still be rebuilt
against the final source, with its identity and packaged runtime checks recorded in the release evidence.

The read-only upstream audit did not rerun native or app suites. Current release validation is recorded
with the release evidence rather than inferred from this source review. In particular, the earlier
[native-compaction qualification](openai-native-compaction.md) records an order-dependent daemon unit-test
stall; it is not a clean full-workspace pass.

For a future base, run every local regression on unpatched upstream, retire only demonstrated superseded
fixes, and reconcile the remaining source manually. Repeat native workspace checks, both-engine integration,
model/child isolation, speed and compaction transports, resident detach/reconnect/restart, old-history and
executable transitions, helper modes and packaged system-PATH checks. Finish app gates and inspect the
screenshots. Preserve a complete working package and isolated recovery evidence until transition passes.
See [UPSTREAM.md](../UPSTREAM.md) for the full matrix and account-isolation rules.
