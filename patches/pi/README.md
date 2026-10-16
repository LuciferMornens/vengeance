# Vengeance's pi build

Vengeance builds stable `v1.2.0`, commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`,
as `1.2.0+vengeance.4`. See [UPSTREAM.md](../../UPSTREAM.md) and
[engines.lock.json](../../engines.lock.json) for the source and maintenance contract.

The current series also includes native runtime qualification (0003), model catalog qualification
(0004), and Windows native test fixtures (0005). The [October 2026 audit](../../docs/ENGINE-AUDIT-2026-10-14.md)
records the upstream comparison; `v1.2.0` remains the newest stable release at that checkpoint.

Patch `0006` adds the Abliteration provider through native provider and catalog APIs without changing
the pinned catalog files. It supports native API-key login and `ABLIT_KEY`, all three models,
session-affinity headers, current prices and model-specific thinking and image capabilities.
The native `abliteration.test.ts` and `scripts/qa/auth/abliteration.qa.mjs` qualify the integration;
see `UPSTREAM.md` for the provider documentation and retirement criteria.

The distribution patch refuses native self-updates and suppresses upstream release notifications.
Extension/package updates and model catalog refreshes remain native operations. Built-in extensions,
the CLI, RPC entry and the SDK all come from our source checkout. Internal runtime packages are
packed locally and substituted into upstream's installation lock; external dependencies stay pinned.

The compatibility patch keeps the native package version and SDK `VERSION` at `1.2.0`.
Some extensions require a dotted upstream release and reject SemVer build metadata. Distribution
identity lives in `package.json`'s `vengeance.version`, the engine manifest and CLI `--version`.
Install-change detection compares the distribution identity, including builds on the same upstream base.

Run `npm run engines:prepare`, export reviewed native edits into the ordered patch series, then
run `npm run build:engines -- --engine=pi`. Source and payload fingerprints prevent accidental
shipping of unexported checkout edits or stale build output. Model data is hydrated from upstream's
content-addressed catalog before the offline build. The complete runtime and MIT license ship
outside ASAR, and Vengeance runs it with Electron's Node runtime.

Requalify package commands, RPC, SDK imports, bridge capabilities, provider behavior and saved
sessions on every upstream upgrade. Native package self-update tests use temporary directories;
app QA uses local providers and separate configuration stores. Never test against real account files.
