# Vengeance 0.3.8

Vengeance 0.3.8 keeps Abliteration conversations with images working. Abliteration accepts at most
four images in one request, so a conversation's fifth image used to make every later turn fail with
_The request was rejected_ (`media_count_exceeded`).

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.8.exe`               |
| macOS Apple silicon | `Vengeance-0.3.8-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.8-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.8/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.3.7, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.8/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Abliteration and images.** Engine now sends the four newest images of a conversation to
  Abliterated Model and Abliterated Large Flash and replaces older ones with a short note, so pasted
  images and screenshots read by tools no longer stop the conversation. Saved sessions keep every
  image; switching to a model that accepts more images sends them again.
- **Per-request image limits.** Engine applies each model's declared per-request image limit, which
  upstream pi only describes. Engine is now `1.4.0+vengeance.2` with patch `0011`; Engine 2 is
  unchanged at `0.10.1+vengeance.1`.

## Limits

Abliteration's limit of four images per request is set by its API (checked on 29 October 2026). A
model that has to compare more than four images at once needs them spread over several turns.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.8/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the release qualification scope. The tag run and the published release's receipts
identify the qualified shipping bytes.
