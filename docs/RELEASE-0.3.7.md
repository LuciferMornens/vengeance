# Vengeance 0.3.7

Vengeance 0.3.7 moves both engines to their newest stable upstream releases. A provider that is out
of capacity no longer reads as your rate limit, and Abliteration lists all four of its models,
including the new Abliterated Large Flash.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.7.exe`               |
| macOS Apple silicon | `Vengeance-0.3.7-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.7-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.7/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.3.6, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.7/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Engine builds.** Engine is now `1.4.0+vengeance.1`, built from stable pi `v1.4.0`, and Engine 2
  is `0.10.1+vengeance.1`, built from stable Prime Agent `v0.10.1`. Both carry the Vengeance patch
  series rebased onto the new bases; Engine 2 drops three patches that upstream now ships. The
  [engine audit](https://github.com/LuciferMornens/vengeance/blob/v0.3.7/docs/ENGINE-STABLE-AUDIT-2026-10-26.md)
  records each decision.
- **A provider overload is not your rate limit.** When a provider answers that it has no capacity
  for a model, for example Kimi Code's `engine_overloaded_error` on K3.1 Pro Highspeed, the error
  card now says _The provider is overloaded_ and explains that your plan's usage limits are not the
  cause. It offers **Change model**, which opens the model picker. The provider's own message stays
  under Details. Real rate-limit and quota errors keep their own titles.
- **Abliteration models.** Engine lists Abliterated Model, Abliterated Large, Abliterated Large v2
  and the new Abliterated Large Flash, with its 1M-token context. Each offers its full effort range.
- **Engine 2's Python tool.** Upstream renamed it from `ipython` to `python_repl`. Saved
  conversations that used the old name keep working.

## Limits

An overloaded model clears on the provider's side; Vengeance cannot add capacity. Retry later or
pick another model.

Kimi K3.1 Pro and K3.1 Pro Highspeed come from Engine's catalog refresh, not the pinned catalog of
pi `v1.4.0`.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.7/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the release qualification scope.

The [qualification checkpoint](https://github.com/LuciferMornens/vengeance/blob/v0.3.7/docs/RELEASE-QUALIFICATION-0.3.7.md)
records local and CI evidence. The tag run and the published release's receipts identify the
qualified shipping bytes.
