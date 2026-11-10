# Vengeance 0.4.1

Vengeance 0.4.1 adds Claude Fable 5.2 to both engines, including through a Claude subscription, and
moves the Engine to pi 1.5.1.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.4.1.exe`               |
| macOS Apple silicon | `Vengeance-0.4.1-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.4.1-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.4.1/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.4.0, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.4.1/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Claude Fable 5.2 on both engines.** `claude-fable-5-2` is included with a 1M-token context,
  128K output tokens and $8 and $40 per million input and output tokens ($0.20 cache reads, $10
  cache writes). It thinks on every turn, so Off isn't offered. With an Anthropic API key, Fast mode
  is offered at twice the price, as on Opus 5.
- **Fable 5.2 through a Claude subscription.** Anthropic serves Fable 5.2 to a subscription sign-in
  only when it identifies as Claude Code 2.1.290 or newer. Both engines identified as an older
  release, which Anthropic refused with "Claude Code 2.1.280 does not support this model" (2.1.281 on
  Engine 2); they now identify as 2.1.322.
- **The Engine on pi 1.5.1.** Anthropic requests send only the new messages while the server
  continues the conversation, and fall back to the full request after a compaction or a tool change.
  Prompt caches now stay warm for up to 30 minutes between runs when a refresh costs less than
  rebuilding the cache; choose **During runs** in **Settings → Models → Cache warming** for the
  previous behavior. Reading and searching large files no longer loads them whole, which could run
  out of memory; file search on Windows matches path patterns again; edits in files with mixed line
  endings keep those of untouched lines; a sign-in token refreshed while the Engine stops is saved instead of lost; and a
  reply cut off mid-stream is retried.
- **Engine `1.5.1+vengeance.1` and Engine 2 `0.10.2+vengeance.3`.** The Engine keeps all thirteen
  patches on its new base. Both builds add Fable 5.2 and the newer Claude Code identity as patches
  `0014` and `0027` until their upstream catalogs list the model.

## Limits

An extension that sends its own Claude Code identity overrides the Engine's. Pi Black through commit
`036a8a7` claims 2.1.280, so with it enabled Fable 5.2 answers "does not support this model" on the
Engine until Pi Black claims 2.1.290 or newer. Fable 5.2's prices and limits come from Anthropic's
documentation, since neither engine's upstream catalog listed the model on 10 November 2026. Each
cache refresh between runs is a small billed request.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.4.1/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the release qualification scope. The tag run and the published release's receipts
identify the qualified shipping bytes.
