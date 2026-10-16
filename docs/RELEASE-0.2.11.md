# Vengeance 0.2.11 release verification

Built on Windows x64 on 16 October 2026. The production installer is available locally.

## Included changes

- App version advances from 0.2.10 to 0.2.11 in `package.json` and both root lockfile fields.
- Engine advances to `1.2.0+vengeance.4`, including the native Abliteration provider from `94c3ae2`.
  All three models are built in, with native API-key login, `ABLIT_KEY`, current pricing and limits,
  image support on the base model and per-session cache affinity.
- Abliterated Model Large V2 exposes Minimal, Low, Medium, High, Extra high and Max. The provider
  accepts all six effort values and maps them to its low/high/max depths. Off is unavailable because
  this model always reasons. All six values passed live tests during provider qualification; see
  [UPSTREAM.md](../UPSTREAM.md).
- Engine 2 stays at `0.10.0+vengeance.6`.
- The Abliteration QA suite accepts `QA_PACKAGED_EXE` to exercise the shipped runtime.

## Build

Logs are in `.engine-staging/release-0.2.11/`.

```text
npm run typecheck                [exit 0, both TypeScript projects]
npm run checks                   ✓ all checks passed
npm run dist                     • building block map  blockMapFile=release\Vengeance-Setup-0.2.11.exe.blockmap
node scripts/dist-qa.mjs --dir   prime: verified 0.10.0+vengeance.6 (61 files)
```

```text
npm exec --yes --package=prettier -- prettier --check README.md docs/RELEASE-0.2.11.md package.json package-lock.json scripts/qa/auth/abliteration.qa.mjs
  All matched files use Prettier code style!
git diff --check
  [exit 0, no whitespace errors]
```

The production executable reports ProductVersion `0.2.11.0` and FileVersion `0.2.11`.
Both package hooks verified the full Engine `1.2.0+vengeance.4` and Engine 2
`0.10.0+vengeance.6` payloads. No dependencies were added.

## Packaged verification

```text
QA_PACKAGED_EXE='D:/Coding/vengeance/release/qa/win-unpacked/VengeanceQA.exe' \
QA_REPORT_DIR='D:/Coding/vengeance/.shots/qa/release-0.2.11' \
node scripts/qa/run.mjs --only packaged.qa.mjs --only model-isolation.qa.mjs \
  --only bundled-extensions.qa.mjs --only abliteration.qa.mjs
  All 5 suite(s) passed
npm run shots -- abliteration shell
  Screenshots in D:\Coding\vengeance\.shots
```

The packaged tests exercised all three Abliteration models, each Large V2 effort, native read-tool
continuations, image transport, API-key masking and session affinity with a local provider. They also
verified native Engine 2 parent/child model isolation, restart history, both engines on a system-only
PATH, external bridge/helper loading and extension compatibility. Production About, Updates, main and
preload all report 0.2.11. The production installer was built, not installed or published.

PNG evidence under `.shots/qa/release-0.2.11/` includes
`shell-shots/packaged-4-about.png` and `abliteration-shots/abliteration-03-large-v2-efforts.png`.
These and the final feature screenshots were visually inspected.

## Cleanup

After the packaged checks passed, the old 0.2.8 and 0.2.10 app builds were moved to the Windows
Recycle Bin. Fifteen obsolete build/cache directories were also recycled: five superseded engine
checkouts, the legacy source and qualification directories, the obsolete native baseline, release
logs for 0.2.7–0.2.10, the empty release-baseline directory and the Node/Vite tool caches.

The 0.2.11 production and QA outputs, current staged engine payloads, current source checkouts and
pinned catalogs remain available. The current qualified Engine 2 `.6` package is the next upgrade
baseline. Engine sources, patches and historical qualification records remain in Git.

## Artifacts

| Artifact                                  | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.11.exe`      | `3a1234150d2159c2b7d984dd0b6dc40745bb7e12e1aeeb6fba328870ff79e065` |
| `release/win-unpacked/Vengeance.exe`      | `121632a14882383e7c108a49c9d03f86b3df87bb396619bdc3a8e63111af84d7` |
| `release/win-unpacked/resources/app.asar` | `634565292b88679fa5dca2d607de369470f086b8923c0882c2dc67c61d1c1244` |
