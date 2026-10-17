# Vengeance 0.3.0

Vengeance now runs on **macOS** and **Linux** as well as Windows. This is the first published release:
every package below includes both engines and the Engine 2 sign-in helper. All packages are built
from this tag by the release workflow; the checks it runs are listed at the end.

## Downloads

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.0.exe`               |
| macOS Apple silicon | `Vengeance-0.3.0-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.0-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

On Linux, the deb is for Debian and Ubuntu, the rpm for Fedora and openSUSE, and the pacman package
for Arch and Omarchy; the AppImage and the tar.gz are not tied to a distribution.

Requirements: Windows x64, macOS 13 or later, or Linux with glibc 2.35 or newer (Ubuntu 22.04,
Debian 12, Fedora 36 and later) on Wayland or X11. You bring your own model provider: an API
key, a subscription sign-in or a local model server. Engine 2's Python kernel needs
[uv](https://docs.astral.sh/uv/) on `PATH` or in `~/.local/bin`.

## First launch

The packages are not code-signed by a paid certificate yet, so each system asks once:

- **Windows:** SmartScreen may show "Windows protected your PC". Choose **More info → Run anyway**.
- **macOS:** the app is ad-hoc signed but not notarized. After moving it to Applications, run
  `xattr -dr com.apple.quarantine /Applications/Vengeance.app`, or open it once and choose
  **Open Anyway** in **System Settings → Privacy & Security**.
- **Linux:** `chmod +x` the AppImage and run it, or install the deb, rpm or pacman package with your
  package manager. On Ubuntu 24.04 and newer, prefer the deb: it installs the AppArmor profile
  that Chromium's sandbox needs there.

The [install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.0/README.md#install) has
every command. Check a download against `SHA256SUMS`, or confirm the release workflow built it with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

## What's new

**macOS**

- A native menu bar with the standard app, Edit and Window menus, traffic-light window buttons
  inset into the title bar, and folders that can be dropped on the Dock icon.
- Shortcuts use ⌘ where Windows and Linux use Ctrl, and shortcut hints use the macOS key symbols.
- Wording follows the platform: **Move to Trash** and **Show in Finder** on macOS, the Trash and the
  file manager on Linux.

**Linux**

- Native Wayland and X11. GNOME, KDE Plasma and other floating desktops get window buttons; tiling
  compositors such as Hyprland (Omarchy), sway and niri manage windows themselves, so Vengeance draws
  none. `VENGEANCE_WINDOW_CONTROLS=native` or `none` overrides the choice.
- Stored environment values such as API keys are encrypted when a secret store is running:
  gnome-keyring, KeePassXC or another Secret Service, or KWallet on KDE Plasma.
- Input methods work in the composer under Wayland.

**Every platform**

- On macOS and Linux the engines get your login shell's environment, so tools your shell profile adds
  to `PATH` are found even when Vengeance starts from the Dock or a launcher.
- On macOS and Linux, a forced stop of Engine or a cancelled engine command also ends its child
  processes, Engine 2 daemons use a private socket folder, and a linked project folder opens as its
  target, where its sessions live.
- Updates: the Windows installer and the AppImage update themselves. The macOS apps and the deb,
  rpm, pacman and tar.gz packages tell you about a new version and open its release page.
- Engine `1.3.0+vengeance.2` and Engine 2 `0.10.0+vengeance.10` are rebuilt from the same pinned
  sources for each platform, and the native executables Vengeance compiles, Engine 2 and its
  sign-in helper, are checked on each one.
- Diagrams render with Mermaid 12.2.0 and KaTeX 0.18.10, which fixes a KaTeX security advisory.
- Fixes from reviewing the screenshots of all three platforms. At narrow widths, the inspector tabs,
  tool rows and Activity tiles, subagent cards, the Steer timing switch and the running Engine 2
  footer no longer squeeze their labels or overflow. The transcript stays pinned to the bottom when
  the composer grows, pasted images keep their paste order, Settings keeps the selected section in
  view, and the image viewer's close button no longer sits under the window buttons.
- Toasts no longer cover the **Jump to latest** pill, the session tree shows a failed reply's readable
  error instead of the provider's raw payload, the command palette keeps workspace names readable
  beside long paths, and "Show in folder" now names Explorer, Finder or the file manager. Clock times
  follow your locale's short time format.
- A number typed into a settings field while its value loads is no longer merged with that value.

## Known limits

- macOS and Linux builds have passed the automated checks below on GitHub's runners. They have not
  yet been tried by hand on a physical Mac or on Hyprland, so please
  [report](https://github.com/LuciferMornens/vengeance/issues/new/choose) anything that looks wrong.
- The rpm is install-tested on Fedora; openSUSE has not been tried.
- The macOS apps cannot update themselves until they carry an Apple Developer ID signature.
- There is no pacman package for arm64; on Arch Linux ARM, use the AppImage or the tar.gz.
- Earlier versions were local Windows builds and are not published.

## How this release was checked

- **CI** on the release commit: typecheck, build and workflow lint, then the app's contract checks
  and every screenshot scenario on Windows x64, macOS arm64 and Linux x64, with engines built the
  way releases build them. Window sizes larger than a runner's display are skipped. Every screenshot
  from all three platforms was reviewed, and after each round of fixes every changed screenshot was
  compared with the run before it.
- **The release workflow** builds each of the five platforms on its own runner and, before it
  creates the release, checks:
  - that each build's app carries the update feed and the `latest` channel;
  - that no Linux executable needs a glibc newer than 2.35;
  - the macOS signatures inside the app, the zip and the dmg;
  - a smoke test on every platform of the app packaged under a separate QA identity, with only the
    system `PATH` and local stand-in providers: both engines stream a reply, and Engine 2 sign-in
    loads the bundled helper;
  - the deb, installed with apt on Ubuntu, and the rpm, installed with dnf on Fedora, both on x64
    and arm64, and the pacman package, installed on Arch Linux x64: the app, Engine 2 and the
    sign-in helper resolve every library, and the launcher entry exists.
- **On Windows x64**, the full screenshot suite and 93 of the 98 application QA suites passed against
  the release tree, in temporary profiles with the mock engine or local stand-in providers and no
  real account. The other five need a real account or an unreleased engine build.
