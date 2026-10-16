# Vengeance 0.2.7 release verification

Built and checked on Windows x64 on 14 October 2026. The application runtime was packaged from
`df8fa5a` on `main`; this verification record and final documentation clarifications are committed
afterward. The installer is built locally, not installed or published.

## Included changes

- Engine 2 keeps each parent's resolved model when sibling sessions change native defaults or
  a child using another model finishes. GPT 6.1 Sol / Max / Fast survives restart with saved history.
- Native settings/MCP saves merge changed fields under the native lock, keeping concurrent and
  unfamiliar settings. This is the reviewed upstream backport documented in the
  [engine audit](ENGINE-AUDIT-2026-10-14.md).
- Resident sessions report running and selected engine versions, offer a guarded restart, and
  resolve incomplete capabilities through their own native catalog. **Close tab** leaves a saved
  resident in **Background sessions**; **Stop session** ends it while keeping saved history.
- The unsupported Decision model setting is removed. Screenshot failures now print renderer errors.
- App version metadata advances from 0.2.6 to 0.2.7 in `package.json` and both root lockfile fields.
  About, Updates, preload and executable version metadata report the new version.

The native payloads are identical to those qualified in the
[14 October engine audit](ENGINE-AUDIT-2026-10-14.md). Engine remains `1.2.0+vengeance.3`
(upstream SDK `1.2.0`); Engine 2 remains `0.10.0+vengeance.5`. This release preparation changes
documentation and app version metadata, with no further native, shutdown or error-path changes.
Full native workspace qualification is recorded in that audit; it was not repeated for the version bump.

## Documentation audit

All tracked Vengeance Markdown documentation and the helper notice were reviewed. QA prompt/skill
Markdown files are fixture data, not contributor instructions. The maintained guides now describe
bundled-engine resolution, the separate SDK host, native resident ownership, actual IPC signatures,
dual-engine account isolation, candidate baseline inputs and serial UI qualification.

`FOUNDATION.md` is now the current development guide. Its obsolete PATH discovery, removed `sdk.ts`,
unfinished-feature claims and Wave 1 validation status were replaced. `SPEC.md` distinguishes product
requirements from completed integration, fixes outdated architecture/control descriptions and removes
unresolvable work-package references. Design review guidance no longer asserts a universal contrast
ratio; QA documentation states the native compaction reserve and resulting fixture threshold separately.

[README.md](../README.md) indexes the maintained guides and release history. Older reports explicitly
identify their historical checkpoint: original versions, hashes, account observations and test results
remain intact. Local documentation links and documented npm script names resolve; package/lock versions
agree. Native integration gaps remain visible in the engine audit rather than being labeled full parity.

## Validation

All commands below completed successfully against the final runtime build. UI suites ran serially
after renderer compilation. Logs are under `.engine-staging/release-0.2.7/`.

```text
npm run typecheck
> tsc --noEmit -p tsconfig.web.json
[exit 0, both TypeScript projects]

npm run checks
✓ all checks passed

npm run dist
> npm run build && node scripts/dist.mjs
✓ built in 19.78s
• building block map  blockMapFile=release\Vengeance-Setup-0.2.7.exe.blockmap
[exit 0]

node scripts/dist-qa.mjs --dir
pi: verified 1.2.0+vengeance.3 (14951 files)
prime: verified 0.10.0+vengeance.5 (61 files)
[exit 0]

npm run shots
Screenshots in D:\Coding\vengeance\.shots
[exit 0]
```

`npm run dist` runs the required `npm run build` gate before packaging. Vite's existing mixed-import
and large-chunk notices remain warnings. The full screenshot gate ran 16 scenario files and produced
323 PNGs with no failure. Its only renderer-error report is the deliberate malformed transcript frame
in `transcript-recovery.mjs`; recovery and draft retention passed. The composer double-Escape/tree and
Bone-theme sequence also passed, with no recurrence of the blank QA window.

Packaged qualification used this command:

```sh
QA_PACKAGED_EXE='D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe' \
QA_PI_PACKAGE_ROOT='C:/Users/dev/.pi/agent' \
QA_REPORT_DIR='D:/Coding/vengeance/.shots/qa/release-0.2.7' \
node scripts/qa/run.mjs --only packaged.qa.mjs --only model-isolation.qa.mjs \
  --only bundled-extensions.qa.mjs
```

```text
PASS engines/model-isolation.qa.mjs (45.9s)
PASS engines/packaged.qa.mjs (31.5s)
PASS ext/bundled-extensions.qa.mjs (22.4s)
PASS shell/packaged.qa.mjs (6.0s)
All 4 suite(s) passed
```

Both native engines completed local-provider turns. The external bridge and native helper loaded,
including helper operation with a system-only PATH. Compatibility extensions were copied into
temporary storage, retained saved history across restart and completed another turn. Parent request
identity remained GPT 6.1 Sol / Max / priority after child completion and restart. About and Updates
showed 0.2.7. Tests did not complete external sign-in or make paid provider requests.

Inspected PNGs include `composer-light.png`, `prime-engine-settings-models-dark.png` and
`prime-engine-subagents-dark.png` under `.shots/`, plus these under `.shots/qa/release-0.2.7/`:

- `shell-shots/packaged-4-about.png` and `packaged-2-updates-version.png`.
- `engine2-model-isolation-shots/parent-after-restart.png`.
- `packaged-shots/packaged-prime.png`.
- `bundled-extensions-shots/extensions-after-restart.png`.

Mock screenshots use scripted model names; they do not identify a real provider request. The separate
native model-isolation fixture checks the actual request model, reasoning and tier.

Formatting and whitespace verification:

```sh
npx --yes prettier --check README.md AGENTS.md SPEC.md UPSTREAM.md docs/*.md \
  resources/prime-auth/README.md scripts/qa/README.md package.json package-lock.json
# Checking formatting...
# All matched files use Prettier code style!

git diff --check
# exit 0
```

## Artifact identities

The staged, production and QA engine inventories were independently reverified after packaged tests.
All 14,951 Engine files and 61 Engine 2 files match their manifests; both packaged helpers match the
staged helper. The production executable reports ProductVersion `0.2.7.0` and FileVersion `0.2.7`.

| Artifact                            | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.7.exe` | `14dff5a25fff0e328f482a608fcb63e0c5abc61e384f1af84c12d793f1abcf8d` |
| Engine payload inventory            | `b0ab9eb1341f53d1795e9315fcd1b80dae5fb4e2a58ef753834744eab805dad3` |
| Engine 2 payload inventory          | `509fec973268a977befbf8aee6573b30ebed7340ad7fe1a01b979bce7c164ee2` |
| Engine 2 executable                 | `527867a1edb67d2774f64882d5ae12a7a0aafb560e3cc8d768634da026e9b7a5` |
| Native helper                       | `9366465db07222b8c9c5665d19d1e1185441c06bf520a887da64200d4283322b` |

## Repository and runtime state

`main` was fast-forwarded through `8508ca8`, `906b61c` and `df8fa5a`, preserving both feature
branches' full history. Only after ancestry verification, the merged branches
`fix/resident-capabilities-and-background-label` and `codex/engine-upgrades-and-model-stability`
were deleted. Only `main` remains, in one checkout. No Git remote is configured and no push was made.

After qualification, the superseded 0.2.6 installer and blockmap and the completed native debug/test
build cache were moved to the Windows Recycle Bin. The verified 0.2.7 installer, production and QA
unpacked apps, native release build caches, retained engine baseline packages and source checkouts
remain available. A future native debug/test run will rebuild its compilation cache.

The user's installed app, account configuration and running residents were not replaced by these
release checks. Installing the app does not automatically upgrade a running Engine 2 resident;
use its explicit guarded restart when ready.
