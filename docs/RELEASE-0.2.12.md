# Vengeance 0.2.12 release verification

Built on Windows x64 on 16 October 2026. The production installer and isolated QA package are
available locally. The running installed application was not replaced or stopped.

## Included changes

- Saved open sessions have distinct Delete and Close controls. Engine 2 Delete stops the native
  resident before closing its tab. A failed deletion keeps the tab and a retryable dialog available.
  Close continues to detach saved residents, leaving their history and scheduled work available.
- Workspace switching resumes a restored tab before starting an empty session. Recent session
  listings are reused, unchanged rows keep their identity, and invalidations during scans remain
  effective even when the workspace is offscreen or its cached listing was evicted.
- Saved messages render without waiting for command discovery. Long conversations reuse their
  transcript projections, construct consecutive activity groups without quadratic copying, and
  mount only the visible rows of collapsed groups. Streaming Markdown rescans its trailing blocks.
- App version advances from 0.2.11 to 0.2.12. Engine remains `1.2.0+vengeance.4`; Engine 2 remains
  `0.10.0+vengeance.6`. No dependencies or native patches changed.

GPT 6.1 Sol independently reviewed the conversation commit `42c019e` and found no actionable
correctness regressions. Its additional randomized Markdown comparison passed 10,000 append
sequences. Build, GUI and native verification were performed separately below.

## Performance evidence

The isolated native Engine fixture with 10,000 tool calls and 30,003 messages opened in 855 ms and
switched back in 57 ms, with 13 transcript segments mounted. Every message, argument and result was
checked. Repeated reopen/close cycles left 3.1 MiB of renderer heap above the baseline.

A separate fixture with 1,000 consecutive calls in one assistant turn opened in 2,088 ms and switched
back in 66 ms. Its failed calls remained pinned and a deep result remained accessible. These are local
fixture measurements, not guarantees for every workspace or conversation.

Evidence is in `.shots/qa/conversation-performance/` and `.shots/qa/performance-shots/`.

## QA appearance and package parity

QA uses the same frontend as production. The 0.2.12 packages have 144 byte-identical renderer files,
with aggregate SHA-256:

`75b9adb2e41521f27d53de80d2412065bd326617068e92e0fa49eea94fac815a`

Automated QA intentionally sets `VENGEANCE_NO_MICA=1`, forces display scaling to 100%, and uses a
temporary profile. Production can use Windows Mica, native display scaling and saved preferences.
Those differences affect appearance without changing the frontend. The installed app inspected
during this release was 0.2.11 and did not yet include the conversation changes.

The archive comparison is recorded in `.engine-staging/release-0.2.12/renderer-parity.log`.

## Validation

Logs are in `.engine-staging/release-0.2.12/`.

```text
npm run typecheck
  exit 0 for both TypeScript projects
npm run checks
  ✓ all checks passed
npm run dist
  building block map: release/Vengeance-Setup-0.2.12.exe.blockmap
node scripts/dist-qa.mjs --dir
  prime: verified 0.10.0+vengeance.6 (61 files)
node scripts/qa/shell/packaged.qa.mjs
  ✓ shell-packaged passed (6.4s)
QA_PACKAGED_EXE=.../VengeanceQA.exe node scripts/qa/engines/packaged.qa.mjs
  ✓ packaged-engines passed
npm run shots -- shell session-close
  Screenshots in D:\Coding\vengeance\.shots
```

The production package's version display, external bridge, native Engine turn and SDK were checked.
The QA package exercised both bundled engines, native helper loading on a system-only PATH and the
public Engine 2 sign-in flow, canceled before credentials. All accounts and sessions were temporary.

The conversation implementation also passed the full screenshot suite, native resident lifecycle and
deletion tests, and large-history/listing suites before the release version increment. The full
screenshot suite's malformed-message recovery scenario deliberately logs its asserted error.

The new Delete/retry, long-history, production About and both packaged-engine PNGs were visually
inspected. Release screenshots include
`.shots/qa/release-0.2.12/shell-shots/packaged-4-about.png` and
`.shots/qa/release-0.2.12/packaged-shots/packaged-prime.png`.

## Cleanup

Ten obsolete generated artifacts totaling 6,187,296,415 logical bytes (5.76 GiB) were moved to the
Windows Recycle Bin. This removes them from the workspace; their space is not reclaimed until the
Recycle Bin is emptied. Direct recursive deletion was blocked, so cleanup used the recoverable path.

The recycled items were the Rust build target, three helper test-cache folders, duplicate native
package staging folders, Node test cache, Ruff cache, and the 0.2.11 installer/blockmap. Current
production and QA outputs, source checkouts, pinned catalogs, build receipts and qualification
evidence remain. Neither active Engine 2 runtime cache nor user account/session data was touched.

## Artifacts

| Artifact                                  | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.12.exe`      | `836e2bedd005395fa6984a52d85b3598ae0601749a369828bf2e05eaf78af367` |
| `release/win-unpacked/Vengeance.exe`      | `ba81c4d225f775c3a7639361801de7298fda9df0d59bb08a2cb0b84d063290d4` |
| `release/win-unpacked/resources/app.asar` | `5e27aa9eb0263f831dca52fa197ba43e411dde421894f6792095f82d23ab49bd` |
