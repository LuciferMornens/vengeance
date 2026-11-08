# Vengeance 0.4.0

Vengeance 0.4.0 adds Audn to both engines and shows when Engine 2 refuses a message with images.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.4.0.exe`               |
| macOS Apple silicon | `Vengeance-0.4.0-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.4.0-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.4.0/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.3.9, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.4.0/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Audn on both engines.** Necromicon (`necromicon`) is included, with a 1M-token context, tools
  and Low, High and Max reasoning effort. Connect in **Settings → Providers & accounts → Audn**, or
  supply `AUDN_API_KEY` in the launch environment. Audn describes Necromicon as Kimi K3.1 Pro with
  its own abliteration, while its model list names a different base, so Vengeance shows Audn's own
  name.
- **Images on models that can't read them.** Engine 2 refuses such a message unless its image model
  setting routes it to a model that can. The refusal used to reach no one, so the message just sat
  there without an answer. It now shows as an error card under the message, with **Change model** and
  **Set image model**. Before you send, the composer says whether Engine 2 will refuse the message or
  which image model will answer it; on the Engine it still says the images will be ignored. Other
  turns Engine 2 ends before running, such as one for a provider without credentials, show their
  error the same way.
- **Engine `1.5.0+vengeance.2` and Engine 2 `0.10.2+vengeance.2`.** Both builds keep their upstream
  bases and add the Audn provider as patches `0013` and `0026`.

## Limits

Necromicon keeps reasoning even when asked not to, so reasoning can't be turned off, and a saved Off
moves to Low. A saved Minimal, Medium or Extra high moves to Low, High or Max. On small prompts the
three levels made no measurable difference (checked on 7 November 2026). Audn's API accepts images,
but the model doesn't see them, so Vengeance treats it as a text-only model. It also ignores the
output limit a request asks for; Audn lists 32,768 output tokens. Audn lists no cache write price,
so the cost estimate uses the input price.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.4.0/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the release qualification scope. The tag run and the published release's receipts
identify the qualified shipping bytes.
