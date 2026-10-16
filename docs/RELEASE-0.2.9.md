# Vengeance 0.2.9 release verification

Built and checked on Windows x64 on 15 October 2026 from `codex/native-compaction`.
The production installer is ready locally. The installed production application was not replaced,
and no release was published.

## Included changes

- App version advances from 0.2.8 to 0.2.9 in `package.json` and both root lockfile fields.
- Includes the native OpenAI compaction fix from `9c717dd`: both engines use the actual conversation
  and protocol trigger, without the injected “Reply with OK only” instruction. Invalid, cancelled
  and legacy checkpoints safely fall back to text summaries.
- Engine remains `1.2.0+vengeance.3`; Engine 2 advances from the 0.2.8 release's
  `0.10.0+vengeance.5` to `0.10.0+vengeance.6`.
- Compaction QA accepts `QA_PACKAGED_EXE`, clears development engine overrides, and verifies that
  the packaged application selects its bundled engine. This tests the installed payload directly.

The [native compaction report](openai-native-compaction.md) records the implementation, live API-key
and subscription qualification, source patches, and broader native-suite coverage limits.

## Build and installer tests

Logs and cleanup receipts are in `.engine-staging/release-0.2.9/`.

```text
npm run typecheck
[exit 0, both TypeScript projects]

npm run checks
✓ all checks passed

npm run dist
• building block map  blockMapFile=release\Vengeance-Setup-0.2.9.exe.blockmap

node scripts/dist-qa.mjs
• building block map  blockMapFile=release\qa\VengeanceQA-Setup-0.2.9.exe.blockmap

node scripts/qa/engines/packaged.qa.mjs
✓ packaged-engines passed

node scripts/qa/engines/native-compaction.qa.mjs
✓ task continuation, report, reload, repeated compaction, fallback and cancellation
[all five authentication/engine routes]

node scripts/qa/shell/packaged.qa.mjs
✓ shell-packaged passed (4.5s)

npm run shots -- settings-engines session-close transcript-recovery
Screenshots in D:\Coding\vengeance\.shots
```

The QA NSIS installer uses the repository's separate `com.vengeance.qa` identity, without shortcuts
or automatic launch. It installed silently into a fresh directory under `D:\Coding\.vengeance-qa-tmp`
and exited 0. Tests ran against that installed executable with isolated account/session directories
and local fake providers. Both engines streamed, the external bridge loaded, and the helper loaded
with only the Windows system PATH. Public sign-in reached its prompt and was cancelled before a key.
The installed engine inventories matched all 14,951 Engine files and 61 Engine 2 files.

The installed compaction matrix finished its file task and report after compaction on all five routes,
then checked saved-session replay, repeated compaction, fallback, legacy recovery and cancellation.
The production unpacked app separately passed version display and bridge tests. About and Updates
show 0.2.9; the executable reports ProductVersion `0.2.9.0` and FileVersion `0.2.9`.

QA uninstallation also exited 0 and removed its executable and registration. The production uninstall
registration and installed executable hash stayed unchanged. Neither existing Engine 2 resident was
restarted or stopped. No paid model calls or external provider sign-ins were needed for this release.

PNG evidence was inspected under `.shots/qa/release-0.2.9-installed/`, including
`native-compaction-shots/pi-api-finished.png`, `prime-chatgpt-finished.png`,
`shell-shots/packaged-4-about.png` and `packaged-2-updates-version.png`.
The three targeted screenshot scenarios passed; transcript recovery deliberately injects and asserts
a malformed-frame error to exercise its error boundary.

## Artifacts and retained baseline

| Artifact                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.9.exe`                 | `2a66331863eb04886ed0ff71c5af05b6b8e34187ec1854a0f8e1f4ae011728e6` |
| `release/qa/VengeanceQA-Setup-0.2.9.exe`            | `f45b8d02b4ee15ee9b15e95da8c5e49c672305b762dfa53208e6ec97f22496f9` |
| `release/baselines/0.2.8/Vengeance-Setup-0.2.8.exe` | `87493595c3a71c4254e7d385472d5705d4c5b2c4d4d4e0a366645b763334bfb3` |

The complete qualified 0.2.8 unpacked package, installer and blockmap are retained together under
`release/baselines/0.2.8/`. Its Engine 2 executable still matches the `.5` baseline hash used in the
successful `.5` to `.6` session-transition qualification. Retaining a package does not guarantee
rollback of arbitrary newer session data; the documented transition evidence remains the limit.

## Cleanup

After the installer and application tests passed, Cargo's scoped `clean --profile dev` removed
33,642 debug/test build files, reporting **56.3 GiB**. Release compiler caches, current source
checkouts, current staged payloads and both 0.2.9 packages remain available.

Two superseded source checkouts (`051cb10b`, `5b44e1a7`) matched their recorded source fingerprints
before removal. They and the obsolete `retained-20261014` bundle and `qualified/resident-prime.3`
package were moved to the Windows Recycle Bin. Checkouts containing local edits were retained.
The empty installer fixture and the matching QA updater installer copy were also recycled.

All removal targets were resolved and checked against their intended directories and running
executables. No user runtime cache was removed. The two pre-existing residents kept the same PIDs,
creation times and executable paths. Staged and production engine inventories passed again after
cleanup, and the new installer and retained baseline hashes remained unchanged.
