# Vengeance's Prime Agent build

Follow [UPSTREAM.md](../../UPSTREAM.md) for reconstruction and qualification.

Vengeance ships a source build of stable `v0.10.0`, upstream commit
`763094e1b6a7c17450ee8399b06cda1853847ca5`, identified as `0.10.0+vengeance.11`.
The exact source, catalog revision, toolchain and patch order live in
[engines.lock.json](../../engines.lock.json). The native helper links this same stable base.

| Patch | Purpose                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------- |
| 0001  | Cancel provider HTTP streams when compaction is aborted.                                                  |
| 0002  | Synchronize durable user-shell output with live model context and guard replacement admission.            |
| 0003  | Compare release archive paths portably on Windows.                                                        |
| 0004  | Identify the Vengeance build and refuse independent native self-updates, including CLI and TUI paths.     |
| 0005  | Preserve Fast/Ultrafast preferences and enforce native account tier eligibility at the provider boundary. |
| 0006  | Qualify Windows session caches and file leases.                                                           |
| 0007  | Preserve fragmented daemon commands across interleaved events and qualify named-pipe cancellation.        |
| 0008  | Isolate and qualify native test fixtures on Windows.                                                      |
| 0009  | Launch npm package operations correctly on Windows.                                                       |
| 0010  | Report Windows edit failures without hiding the native error.                                             |
| 0011  | Rotate Windows incident logs without retaining an open file handle.                                       |
| 0012  | Refresh native prompt and kernel image capabilities after changing models.                                |
| 0013  | Pin the resolved creation model to its session so another worker's default changes cannot alter it.       |
| 0014  | Backport upstream settings/MCP save preservation, retaining concurrent and unknown settings.              |
| 0015  | Carry validated OpenAI native compaction checkpoints through transport and saved-session replay.          |
| 0016  | Read native lineage without legacy migration; resolve endpoints and tombstones from one ledger snapshot.  |
| 0017  | Backport the upstream rustls 0.23.46 lockfile maintenance without changing other dependency pins.         |
| 0018  | Keep each OAuth refresh flight through credential persistence so waiting callers reuse its token.         |
| 0019  | Coordinate native timing/lifecycle fixtures and expose a private receive seam for piped-input tests.      |
| 0020  | Include native APPEND_SYSTEM sources in session prompts and prompt dumps, preserving raw text.            |
| 0021  | Bound ACP fixture shutdown and collect stderr without waiting for inherited Windows pipe handles.         |
| 0022  | Backport upstream's bounded-lock concurrency fixture while asserting all 80 writes land.                  |

Patch 0014 comes from upstream commit
[`7b89c111da0f1d9e67849b34f10552bbb4bd1bd1`](https://github.com/PrimeIntellect-ai/prime-agent/commit/7b89c111da0f1d9e67849b34f10552bbb4bd1bd1).
Its service-tier hunk is rebased around patch 0005's `Ultrafast` variant; that variant remains intact.
The upstream persistence and CLI MCP regression tests travel with the patch. Patch 0013 has a native
session/default isolation regression and app coverage in `scripts/qa/engines/model-isolation.qa.mjs`.
See [the October 2026 audit](../../docs/ENGINE-AUDIT-2026-10-14.md) for selection and qualification evidence.

The [16 October stable audit](../../docs/PRIME-STABLE-AUDIT-2026-10-16.md) records the latest release
and tag checks, patch retirement candidates and helper qualification boundaries. Patch 0015's protocol,
persistence and transport evidence is in [OpenAI native compaction](../../docs/openai-native-compaction.md).
Patch 0016 adds a read-only ledger constructor and an endpoint-resolution snapshot; ordinary native
ledger construction and migration keep their upstream behavior. The helper uses bounded native headers
for topology and leaves transcript summaries to the app's cached session index.
Patch 0018 fixes a stable-base concurrency race: releasing a provider's refresh gate before saving
its credential could spend a single-use refresh token twice. The gate covers persistence and reload;
token HTTP stays outside the document lock. A regression pauses the first credential write while
a second public resolver attempts to refresh. Existing peer-writer and refresh tests also qualify it.
Patch 0019 primarily changes fixtures: virtual timer ticks verify coalescing and retry expiry, while a native
admission barrier verifies that goal pause withdraws an actual queued continuation. The retry-broadcast
fixture shuts down its native worker before dropping its runtime, closing subprocess pipe readers.
Piped-input collection accepts a private receive function so its reset test can script arrivals;
production still calls the standard receiver's `recv_timeout` with the full idle window on every read.
Assertions keep their behavioral contracts rather than relying on provider speed or scheduler timing.

Patch 0020 adapts upstream
[`b1d71636710b0ea1b86380dfe3923b3c03fe2948`](https://github.com/PrimeIntellect-ai/prime-agent/commit/b1d71636710b0ea1b86380dfe3923b3c03fe2948):
the session engine passes explicit append sources through the native resource loader and includes its
resolved text in the native prompt builder. The stable builder's direct `prompt_guidelines` API remains
available. The patch also includes discovered append sources in the CLI's `prompt` breakdown. Native
provider regressions cover independent SYSTEM/APPEND scope precedence, explicit literals and files,
empty overrides, raw Markdown and whitespace, default foundation layers, and a live model switch.
Retirement requires those regressions and the CLI diagnostic case to pass on the candidate upstream
base; the newer core fix alone does not qualify the CLI dump or the app's saved-worker restart path.

Patch 0021 is test-only. The ACP fixture captures stderr in an anonymous temporary file, so
descendants holding inherited Windows handles cannot stall its diagnostic reader. Cleanup requires
the fixture socket's native shutdown acknowledgement, connection closure and supervisor process exit
within a bounded asynchronous operation. Its child cleanup is also bounded. Cleanup errors fail the
test visibly, or print alongside an active assertion failure without causing a second panic. The
session/new and successful ACP EOF-exit assertions remain intact. The regression must pass without
external process intervention before this fixture is qualified on a new upstream base.

Patch 0022 backports only the refinement-test hunk from upstream
[`f0d9c09676a1e6bb2782ad73eb3025ffdf2061d4`](https://github.com/PrimeIntellect-ai/prime-agent/commit/f0d9c09676a1e6bb2782ad73eb3025ffdf2061d4);
its unrelated abort-boundary fixture hunk is excluded. The runtime lock intentionally has a bounded,
unfair wait: repeated writer reacquisition can exhaust a waiter's retry budget without losing an
accepted update. The stable fixture failed five isolated runs on Windows; the logs remain in
`.cache/prime-refinement-repeat-{1..5}.log`. The upstream fixture races two fresh writers in each of
40 rounds and still asserts all 80 updates, avoiding repeated reacquisition by one writer within a
round. This is a test-only backport, not a runtime lock fix; lock behavior and timeouts do not change.
Retire it when a candidate upstream base incorporates the hunk and passes repeated isolated runs
and the full native suite. Qualification of this local backport is recorded with the release checks.

The first three patches originated on development commit
`fa20be8e487b1889c2395ea33906149aef983ca0`. Patch 0002 was rebased onto stable source:
the user-shell tests are extracted into modules and the stable configuration type is used.
Historical verification for the development build does not qualify this stable build.

Run `npm run engines:prepare` or `npm run build:engines -- --engine=prime` from Vengeance.
The builder checks the tag's commit, applies each patch with `git apply`, and refuses an edited
checkout unless its changes have been exported into the patch series. These patches include
plain diffs, so `git am` is not the reconstruction command.

Each platform builds natively with Rust/Cargo 1.98.1 (`rust-toolchain.toml`), the host's Rust
target from the engine lock, the upstream Cargo lock and `VENGEANCE_ENGINE_BUILD` from the engine
lock. Checkouts use LF line endings on every host, so compiled-in prompts and shipped text match.
Windows (`x86_64-pc-windows-gnu`) strips debug information with the toolchain's `rust-objcopy` and
rejects external GNU runtime DLL imports found by GNU objdump. Linux uses upstream's
`split_debug.py` and passes the decoder to the packer; the decoder never ships. Its executable may
link only the C runtime and no symbol newer than GLIBC 2.35, so Linux builds run in Ubuntu 22.04.
macOS builds target macOS 13.0, keep the linked Mach-O, may link only system libraries and
frameworks, and receive a reproducible ad-hoc signature before packaging. Every platform then
invokes upstream's release packager. It ships the complete kernel package, skills, catalogs,
Cargo lock and MIT license. An executable alone is not a deployable package.

The app copies this package to an immutable runtime directory keyed by the payload hash.
Resident processes can survive app upgrades without locking installer resources. Engine files
are separate from native account/session stores; the builder does not modify global installations.

Native regression tests use temporary account, session and kernel directories outside the user's
home and repository. The HTTP cancellation tests use held local provider streams. The user-shell
tests exercise completed shell output reaching a subsequent provider request, replacement races,
durable-history consistency and compaction. Re-run them and the public app suites on each new base.

Before shipping, run formatting, native regressions, clippy, app checks, both-engine integration,
Stop/compaction, shell/queue, controls/restart, saved history, executable transition and packaged
app QA. Exact release evidence belongs in the release verification record, with each platform's
manifest payload hashes and package hashes. Never substitute historical passing counts.

When upstream incorporates a local fix, demonstrate the regression passing on that upstream base,
then remove the redundant patch. Do not blindly carry patches or the helper across releases.
