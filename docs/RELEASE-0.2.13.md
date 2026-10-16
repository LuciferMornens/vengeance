# Vengeance 0.2.13 release verification

Built and verified on Windows x64 on 16 October 2026. The existing installed application was not
replaced or stopped. Bundled Engine versions remain `1.2.0+vengeance.4` and `0.10.0+vengeance.6`.

## Conversation controls

- An idle saved conversation can switch engines in its current tab. Its draft and selected branch's
  history stay available, including pre-compaction turns, tool results, images and context edits.
- The destination uses its own native session writer, model defaults, configuration and credentials.
  It must become ready before the source stops. The source file remains a recovery copy, including
  branches outside the transferred path. A failed candidate is cleaned up without replacing the source.
- Busy work, child agents, app-observed side questions, concurrent operations, reconnects and tab
  closure are guarded. Destination startup widgets and dialogs are delivered; startup editor text
  cannot overwrite the carried draft.
- The composer distinguishes switching this conversation from starting a new one. The sidebar offers
  both engines directly, labels each conversation's engine, and identifies the workspace default
  separately. These actions do not change that default.
- Native control metadata stays archived instead of becoming transcript or model-context text.
  Metadata-only conversations stay empty. ISO timestamps on native historical messages remain stable.
- Nonempty ephemeral conversations cannot switch. Native goals, schedules, kernel state and child
  workers do not transfer. Switching from Engine 2 deliberately stops its source resident after the
  destination is ready.
- Mock session storage was extracted into a separate module; touched source files remain below
  800 lines. No dependencies or native engine patches were added.

This release also includes the deletion and long-conversation improvements verified in
[0.2.12](RELEASE-0.2.12.md).

## Review and validation

GPT 6.1 Sol independently reviewed the implementation, its pinned native contracts, and the exact
public PR files. Its findings were fixed before release. The code review identified no remaining
actionable findings at public code head `f5c6272de900e428ae76b328ebe29021ed7b2cf0`.

Logs are in `.engine-staging/release-0.2.13/`.

```text
npm run typecheck
  exit 0 for both TypeScript projects
npm run build
  built in 30.11s
npm run checks
  all checks passed
prettier --check (all changed supported files)
  All matched files use Prettier code style!
npm run shots
  19 scenario files passed; Screenshots in D:\Coding\vengeance\.shots
node scripts/qa/engines/engine-switch.qa.mjs
  Engine switching: 5 checks passed
node scripts/qa/engines/packaged.qa.mjs
  packaged-engines passed
node scripts/qa/shell/packaged.qa.mjs
  shell-packaged passed (6.7s)
```

The focused checks include ten switching regressions and seven native-history regressions. Two Rust
helper tests, Rust formatting and Clippy with warnings denied passed against the pinned patched
dependencies. The native round trip verifies actual onward provider requests, both destination
defaults, full history, source recovery, active-work refusal and an empty Engine 2 conversation.
Tests use isolated accounts, session directories and local fake providers.

The full screenshot suite includes a deliberately malformed message in its recovery scenario; its
asserted renderer error and successful recovery are expected. The new menu/dialog views, narrow
layout, native round-trip transcript, packaged Engine 2 view and production About dialog were inspected.
Screenshots include `.shots/engine-switch-*.png`,
`.shots/qa/engine-switch-shots/engine-switch-roundtrip.png`, and `.shots/qa/packaged-shots/`.

## QA appearance and package identity

The production and QA packages contain 149 byte-identical compiled code files, all matching the
tested `out/` build. This includes 144 identical renderer files, with aggregate SHA-256:

`a93e3021fed4d5c1bd7c9bf8ff04de028ef7879d9f58aa25d8760fba41caf0a3`

QA uses an isolated profile, fixed display scaling and disabled Windows Mica. Those runtime settings
can change appearance; the frontend is the same. Verification is recorded in
`.engine-staging/release-0.2.13/artifact-verification.json`.

| Artifact                                  | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `release/Vengeance-Setup-0.2.13.exe`      | `424528449351027ba259b2bb1a34bf91c448ff16e66eac9eeca9c7d0bcf22eb0` |
| `release/win-unpacked/resources/app.asar` | `90b3435d8c3730dbab25a2eefcae58d882dcd615283165a6d2571a91cc840ee4` |

## Publication and cleanup

The public repository starts with a sanitized source snapshot. Personal commit history stays local;
the public baseline omits personal paths and uses clearly synthetic QA credentials. GitHub secret
protection accepted the publication without bypassing its checks. No license was selected on the
user's behalf.

The 0.2.12 installer/blockmap and disposable Rust target directory were moved to the Windows Recycle
Bin: 1,090,840,097 logical bytes (about 1.09 GB). This removes them from the workspace; disk space is
reclaimed when the Recycle Bin is emptied. Current packages, native source checkouts, build receipts,
bundled engines and active runtime caches remain available. No user account or session data was removed.
