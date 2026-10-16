# Vengeance's Prime Agent build

Follow [UPSTREAM.md](../../UPSTREAM.md) for reconstruction and qualification.

Vengeance ships a source build of stable `v0.10.0`, upstream commit
`763094e1b6a7c17450ee8399b06cda1853847ca5`, identified as `0.10.0+vengeance.5`.
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

Patch 0014 comes from upstream commit
[`7b89c111da0f1d9e67849b34f10552bbb4bd1bd1`](https://github.com/PrimeIntellect-ai/prime-agent/commit/7b89c111da0f1d9e67849b34f10552bbb4bd1bd1).
Its service-tier hunk is rebased around patch 0005's `Ultrafast` variant; that variant remains intact.
The upstream persistence and CLI MCP regression tests travel with the patch. Patch 0013 has a native
session/default isolation regression and app coverage in `scripts/qa/engines/model-isolation.qa.mjs`.
See [the October 2026 audit](../../docs/ENGINE-AUDIT-2026-10-14.md) for selection and qualification evidence.

The first three patches originated on development commit
`fa20be8e487b1889c2395ea33906149aef983ca0`. Patch 0002 was rebased onto stable source:
the user-shell tests are extracted into modules and the stable configuration type is used.
Historical verification for the development build does not qualify this stable build.

Run `npm run engines:prepare` or `npm run build:engines -- --engine=prime` from Vengeance.
The builder checks the tag's commit, applies each patch with `git apply`, and refuses an edited
checkout unless its changes have been exported into the patch series. These patches include
plain diffs, so `git am` is not the reconstruction command.

Builds use Rust/Cargo 1.98.1, target `x86_64-pc-windows-gnu`, the upstream Cargo lock,
and `VENGEANCE_ENGINE_BUILD` from the engine lock. The builder strips debug information,
streams PE imports through GNU objdump, rejects external GNU runtime DLL imports, and invokes
upstream's release packager. It ships the complete kernel package, skills, catalogs, Cargo lock
and MIT license. An executable alone is not a deployable package.

The app copies this package to an immutable runtime directory keyed by the payload hash.
Resident processes can survive app upgrades without locking installer resources. Engine files
are separate from native account/session stores; the builder does not modify global installations.

Native regression tests use temporary account, session and kernel directories outside the user's
home and repository. The HTTP cancellation tests use held local provider streams. The user-shell
tests exercise completed shell output reaching a subsequent provider request, replacement races,
durable-history consistency and compaction. Re-run them and the public app suites on each new base.

Before shipping, run formatting, native regressions, clippy, app checks, both-engine integration,
Stop/compaction, shell/queue, controls/restart, saved history, executable transition and packaged
app QA. Exact release evidence belongs in the release verification record, with the manifest's
payload hashes and the installer hash. Never substitute historical passing counts.

When upstream incorporates a local fix, demonstrate the regression passing on that upstream base,
then remove the redundant patch. Do not blindly carry patches or the helper across releases.
