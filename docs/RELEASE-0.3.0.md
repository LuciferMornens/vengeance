# Vengeance 0.3.0

Vengeance now runs on **macOS** and **Linux** as well as Windows. This is the first published release:
every package below includes both engines and the Engine 2 sign-in helper. All packages are built
from this tag by the release workflow and checked before upload.

## Downloads

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.0.exe`               |
| macOS Apple silicon | `Vengeance-0.3.0-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.0-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

On Linux, the deb is for Debian and Ubuntu, the rpm for Fedora and openSUSE, and the pacman package
for Arch and Omarchy; the AppImage and the tar.gz run on any distribution.

Requirements: Windows x64, macOS 13 or later, or Linux with glibc 2.35 or newer (Ubuntu 22.04,
Debian 12, Fedora 36 and later) on Wayland or X11. You bring your own model provider: an API
key or a subscription sign-in. Engine 2's Python kernel needs [uv](https://docs.astral.sh/uv/) on
`PATH` or in `~/.local/bin`.

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

- A native app menu with the standard Edit, View and Window roles, traffic-light window buttons
  inset into the title bar, and folders that can be dropped on the Dock icon.
- Shortcuts use ⌘ where Windows and Linux use Ctrl, and shortcut hints use the macOS key symbols.
- Wording follows the platform: **Move to Trash** and **Show in Finder** on macOS, the Trash and the
  file manager on Linux.

**Linux**

- Native Wayland and X11. GNOME, KDE Plasma and other floating desktops get window buttons; tiling
  compositors such as Hyprland (Omarchy), sway and niri manage windows themselves, so Vengeance draws
  none. `VENGEANCE_WINDOW_CONTROLS=native` or `none` overrides the choice.
- Stored environment values such as API keys are encrypted with gnome-keyring, KeePassXC or another
  Secret Service, or KWallet on KDE Plasma.
- Input methods work in the composer under Wayland.

**Every platform**

- On macOS and Linux the engines get your login shell's environment, so tools your shell profile adds
  to `PATH` are found even when Vengeance starts from the Dock or a launcher.
- On macOS and Linux, stopping an engine stops its whole process group, Engine 2 daemons use a
  private socket folder, and a linked project folder opens as its target, where its sessions live.
- Updates: the Windows installer and the AppImage update themselves. The macOS apps and the deb,
  rpm, pacman and tar.gz packages tell you about a new version and open its release page.
- Engine `1.3.0+vengeance.2` and Engine 2 `0.10.0+vengeance.10` are rebuilt from the same pinned
  sources for each platform, with native runtime checks on every executable.
- Diagrams render with Mermaid 12.2.0 and KaTeX 0.18.10, which fixes a KaTeX security advisory.
- Fixes from a review of every screenshot on all three platforms. At narrow widths, the inspector
  tabs, tool rows and Activity tiles, subagent cards, the Steer timing switch and the running
  Engine 2 toolbar no longer wrap, squeeze or overflow. The transcript stays pinned to the bottom
  when the composer grows, pasted images keep their paste order, Settings keeps the selected section
  in view, and the image viewer's close button no longer sits under the window buttons.

## Known limits

- macOS and Linux builds have passed the automated checks below on GitHub's runners. They have not
  yet been tried by hand on a physical Mac or on Hyprland, so please
  [report](https://github.com/LuciferMornens/vengeance/issues/new/choose) anything that looks wrong.
- The macOS apps cannot update themselves until they carry an Apple Developer ID signature.
- There is no pacman package for arm64; on Arch Linux ARM, use the AppImage or the tar.gz.
- Earlier versions (0.2.x) were local Windows builds and are not published.

## How this release was checked

- **CI** on the release commit: typecheck, build and workflow lint, then the app's contract checks
  and every screenshot scenario on Windows x64, macOS arm64 and Linux x64, against engines built the
  way releases build them. The screenshots from all three platforms were reviewed by eye.
- **The release workflow** builds each of the five platforms on its own runner and, before anything
  is uploaded, checks:
  - that each package carries the update feed and the `latest` channel;
  - that no Linux executable needs a glibc newer than 2.35;
  - the macOS signatures inside the app, the zip and the dmg;
  - a packaged smoke test on every platform, with only the system `PATH` and local stand-in
    providers: both engines stream a reply, and Engine 2 sign-in loads the bundled helper;
  - the deb, installed with apt on Ubuntu x64 and arm64, and the pacman package, installed on Arch
    Linux: the app and native executables resolve every library, and the launcher entry exists.
- **On Windows x64**, the full screenshot suite and the application QA suites ran against the
  release tree in temporary profiles with the mock engine and no real account.
