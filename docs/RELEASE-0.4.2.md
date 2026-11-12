# Vengeance 0.4.2

Vengeance 0.4.2 adds SilkCompute's five abliterated models to both engines.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.4.2.exe`               |
| macOS Apple silicon | `Vengeance-0.4.2-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.4.2-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.4.2/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.4.1, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.4.2/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **SilkCompute on both engines.** Connect in **Settings → Providers & accounts → SilkCompute** with
  an API key, or supply `SILK_API_KEY` in the launch environment. Five abliterated models are
  included, each with a 1M-token context, tools and Off, Low, High and Max reasoning effort:

  | Model                               | Input | Output | Cache reads | Max output | Images |
  | ----------------------------------- | ----- | ------ | ----------- | ---------- | ------ |
  | Kimi K3.1 Pro Uncensored (default)  | $5.00 | $15.00 | $0.50       | 131,072    | Yes    |
  | DeepSeek V4.1 Flash 1017 Uncensored | $0.26 | $0.90  | $0.06       | 131,072    | Yes    |
  | GLM-5.3 Uncensored                  | $2.00 | $4.00  | $0.30       | 131,072    | No     |
  | GLM-5.3 Flash Uncensored            | $0.24 | $1.00  | $0.06       | 131,072    | Yes    |
  | Hy4 Uncensored                      | $1.60 | $3.20  | $0.30       | 65,536     | Yes    |

  Prices are USD per million tokens. Off turns reasoning off on every model. SilkCompute's Kimi
  K3.1 Pro matches Kimi K3.1 Pro's published tokenizer.

- **Engine `1.5.1+vengeance.2` and Engine 2 `0.10.2+vengeance.4`.** Both builds add SilkCompute as
  patches `0015` and `0028` until their upstream catalogs list it.

## Limits

SilkCompute's standard (non-abliterated) models are not included. GLM-5.3 accepts images but cannot
see them, so the composer warns before sending one, and Engine 2 refuses the message unless its image
model setting routes it elsewhere. Hy4 reasons at length at every effort, so short output limits can
cut its answers off. SilkCompute runs eight requests at once per account. Its prices and limits come
from its models page and API on 12 November 2026; it lists no cache write price, so writes are counted
at the input price.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.4.2/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the release qualification scope. The tag run and the published release's receipts
identify the qualified shipping bytes.
