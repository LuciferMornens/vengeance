# Vengeance 0.3.3

Vengeance 0.3.3 adds system prompt inspection and editing, safer engine restarts, and immediate
feedback when opening saved conversations. Syntax highlighting moves out of the window's rendering
thread. Background Engine work stays out of the macOS Dock, and Intel macOS kernel setup includes
a verified cryptography wheel.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.3.exe`               |
| macOS Apple silicon | `Vengeance-0.3.3-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.3-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 or 0.3.2, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Inspect and edit system instructions.** Settings separates each engine's native foundation
  from an open conversation's assembled prompt, with its source and snapshot status. Edit global
  or project `SYSTEM.md`, `APPEND_SYSTEM.md` and context instructions, customize the foundation,
  or restore inherited defaults. Draft protection and external-edit checks prevent accidental
  replacement. Saving keeps work running; applying saved instructions uses an explicit guarded restart.
- **Safer restarts.** Active streams, tools, children, observed side questions and session operations
  block restart. Engine also refuses parked messages; Engine 2 preserves native recovery queues
  during an otherwise idle restart. Each resident keeps its live provider, model and reasoning
  selection, and recovery data remains available if replacement fails. Deferred settings restarts
  retry temporary refusals and retain changes arriving during restart.
- **Responsive conversation opening.** Mouse and keyboard activation show progress while history
  loads. The previous pane keeps its reading position if opening fails, and newer selections take
  priority. History becomes usable before ancillary command and statistics reads finish.
- **Lighter highlighting and stable history reading.** A local worker highlights code with bounded
  caching and a plain-source fallback. Cold saved histories respect upward mouse-wheel scrolling
  instead of pulling the reader back to the latest message. Cached tabs restore scroll observers,
  virtualized histories keep the reader's anchor, and scrolling up during streamed growth pauses following.
- **Native command precedence survives reloads.** Command discovery distinguishes loading, success
  and failure. Reloads invalidate old results and prevent stale responses taking authority.
  Ambiguous slash-command drafts remain intact until the native catalog is known.
- **No extra macOS Dock applications from background work.** Engine RPC, settings SDK/provider hosts,
  CLI work and login-shell probing use Electron's signed background helper. The main app retains
  its normal Dock presence. Missing or invalid helper metadata reports an error; explicit custom
  system Node selection retains its behavior.
- **Engine 2 append instructions reach the native prompt.** `0.10.0+vengeance.12` retains the upstream
  append-file backport, including native prompt diagnostics. Engine remains `1.3.0+vengeance.2`.
  Both source builds keep their pinned stable upstream bases and update with Vengeance.
- **Intel macOS kernel setup uses a bundled cryptography wheel.** Engine 2 includes cryptography
  `50.0.2` with static OpenSSL `4.0.3`, retaining current security fixes without requiring user
  Rust, C or OpenSSL build tools. The engine verifies the wheel before setup or cached-kernel reuse.
  First kernel setup still needs uv and network access.
- **Linux Trash support.** Debian, RPM and pacman packages declare the `gio` dependency used by
  native Trash actions, including restoring inherited instructions.

## Measurements and limits

The historical Windows comparison records Engine first/second visits improving from 825/544 to
491/340 ms and renderer blocking from 128 to 4 ms. Engine 2 blocking falls from 122 to 19 ms, while
wall time is mixed at 877/487 → 901/549 ms. Cached returns cost about 20–25 ms more, and a roughly
210 ms startup frame gap remains. These figures identify the original controlled comparison;
they do not establish a macOS/Linux speed improvement. The
[performance report](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/docs/PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md)
retains methods, exact artifacts and older diagnostic limits.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the local qualification scope.

The [technical qualification checkpoint](https://github.com/LuciferMornens/vengeance/blob/v0.3.3/docs/RELEASE-QUALIFICATION-0.3.3.md)
records identified local and CI evidence. Final PR/tag-run and published-release receipts identify
the qualified shipping bytes; historical results apply only to their recorded source and platforms.
