# Vengeance 0.2.10 release verification

Built and checked on Windows x64 on 15 October 2026 from `main`. The production installer is ready
locally. The installed production application was not replaced, and no release was published.

## Included changes

- App version advances from 0.2.9 to 0.2.10 in `package.json` and both root lockfile fields.
- The Engine's todo list docked above the composer collapses and expands from its heading
  (`e758d9f`). Collapsed, it is one row with the title, progress and the task in progress (or the
  next open one). Expanded, long lists scroll under the heading instead of pushing the transcript
  away. The choice is one app-wide preference, `features.composer.checklistCollapsed`, shared by the
  tool-derived list and extension checklist widgets. The inspector list always stays open.
- Everything from 0.2.9 is included: the docked todo list (`a2e5950`) and the native OpenAI
  compaction fix (`9c717dd`).
- Engines are unchanged from 0.2.9: Engine `1.2.0+vengeance.3`, Engine 2 `0.10.0+vengeance.6`.

## Branches

`codex/native-compaction` fast-forwarded into `main` and was deleted. `main` is the only branch,
with one worktree, no stashes and no remote.

## Build and packaged tests

Logs are in `.engine-staging/release-0.2.10/`.

```text
npm run typecheck                [exit 0, both TypeScript projects]
npm run checks                   ✓ all checks passed
npm run dist                     • building block map  blockMapFile=release\Vengeance-Setup-0.2.10.exe.blockmap
node scripts/dist-qa.mjs --dir   prime: verified 0.10.0+vengeance.6 (61 files)
node scripts/qa/run.mjs --only packaged.qa.mjs --only model-isolation.qa.mjs \
  --only bundled-extensions.qa.mjs
                                 All 4 suite(s) passed
```

The packaged suites ran against `release/qa/win-unpacked/VengeanceQA.exe` with isolated account
directories and a local fake provider. They confirmed app version 0.2.10 in main and preload, the
bridge outside `app.asar`, a real turn through the fake LLM, and the version in Updates, Settings
and About. Before the release, the `responsive`, `composer`, `chat`, `shell` and `subagents`
screenshot suites passed; `responsive` collapses and expands the docked list and asserts the
collapsed row.

The executable reports ProductVersion `0.2.10.0` and FileVersion `0.2.10`. PNG evidence is under
`.shots/qa/release-0.2.10/`, including `shell-shots/packaged-4-about.png`. No paid model calls or
provider sign-ins were needed.

## Artifacts

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.10.exe`                | `efb036acb60b0fd5b23ab393944b1e0ad37b0c7c1fb929a5cbea17f68cd74fc6` |
| `release/baselines/0.2.8/Vengeance-Setup-0.2.8.exe` | `87493595c3a71c4254e7d385472d5705d4c5b2c4d4d4e0a366645b763334bfb3` |

The 0.2.9 installer, its blockmap and the 0.2.9 QA installer were moved to the Windows Recycle Bin.
The 0.2.8 baseline stays in place: it holds the Engine 2 `.5` package used to qualify the `.5` to
`.6` session transition (see [Release 0.2.9](RELEASE-0.2.9.md)).
