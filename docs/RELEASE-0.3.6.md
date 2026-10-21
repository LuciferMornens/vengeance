# Vengeance 0.3.6

Vengeance 0.3.6 tidies the sidebar. The workspace switcher drops folders that no longer exist, and the
session list holds only main conversations, with subagent sessions under the conversation that started
them. Both engines are unchanged.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.6.exe`               |
| macOS Apple silicon | `Vengeance-0.3.6-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.6-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.6/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.3.5, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.6/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Workspaces that exist.** Saved history can outlive its folder. Test suites, for example, leave
  history for temporary folders they already deleted. Those folders no longer become workspaces, and
  the ones already listed leave the switcher. A folder you opened that is deleted, or sits on an
  unmounted drive, is left out of the switcher, palette and onboarding until it is back, keeping its
  engine default; opening the switcher looks again. A folder found only through its saved history
  also leaves once its last session is gone. A scan that cannot read all saved history removes
  nothing.
- **The sidebar lists main conversations.** Subagent sessions of both engines sit collapsed under
  the conversation that started them, a subagent's own subagents included. One whose parent is gone
  shows while it runs or is open, and in search results otherwise. The separate _Subagent sessions_
  section is gone. Forks of a subagent session and pinned subagent sessions stay in the list, and the
  empty state's **Recent** list shows main conversations only.
- **Search.** A search that only matches a background session's child task no longer also says
  _No matching sessions_.
- **Engine builds.** Engine stays `1.3.0+vengeance.4` and Engine 2 stays `0.10.0+vengeance.13`.
  Both source builds keep their pinned stable upstream bases and update with Vengeance.

## Limits

Folders you opened stay in the switcher while they exist, even without saved history. Remove one from
the switcher with **Hide workspace**.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.6/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the local qualification scope.

The [qualification checkpoint](https://github.com/LuciferMornens/vengeance/blob/v0.3.6/docs/RELEASE-QUALIFICATION-0.3.6.md)
records local and CI evidence. The tag run and the published release's receipts identify the
qualified shipping bytes.
