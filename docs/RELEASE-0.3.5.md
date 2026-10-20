# Vengeance 0.3.5

Vengeance 0.3.5 recognizes an Engine sign-in that its provider refused to renew. The provider stops
counting as connected, so extensions and model lists stop picking it, and Settings and the chat offer
_Sign in again_. The Engine gains a native patch for this. CI and release dry runs also got faster.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.5.exe`               |
| macOS Apple silicon | `Vengeance-0.3.5-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.5-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.5/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.3.4, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.5/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Expired sign-ins stop counting as connected.** When a provider's token endpoint refuses to renew
  an Engine OAuth sign-in, the Engine marks that sign-in in `auth.json` and stops using it until you
  sign in again. Before, the provider still counted as signed in. A conversation-title extension
  kept picking it, for example, and every title failed.
- **_Sign in again_ where it matters.** Providers, onboarding, the default-model badge and the model
  picker show **Sign-in expired** with **Sign in again**. A reply that fails on the expired sign-in
  shows the same as a card in the chat, naming the provider instead of the token endpoint's error
  code. Sending, compacting, summarizing a branch, switching models and replying to a subagent show
  it in their error toast. The sign-in that replaces it offers a restart like any other sign-in.
- **Every open conversation stops offering it.** When one conversation meets the refusal, the
  others leave the provider out of their model lists and model cycle without a restart, and their
  extensions stop picking it. A conversation that starts while the mark is there does the same once
  it is ready. This needs no network request and keeps every provider's model filter.
- **Only a real refusal counts.** Timeouts, network errors, server errors and cancellations never
  mark a sign-in. A rejected refresh token from a built-in OAuth flow does: `invalid_grant`, or
  OpenAI's expired, reused or invalidated refresh token.
- **Engine build.** Engine `1.3.0+vengeance.4` adds patch 0010, which marks the refused sign-in,
  fails its requests at once and re-reads sign-ins without a network request. Engine 2 stays
  `0.10.0+vengeance.13` and its sign-ins are unchanged. Both source builds keep their pinned stable
  upstream bases and update with Vengeance.
- **Maintenance.** CI takes about 10 minutes instead of 31, and pull request dry runs reuse CI's
  engine builds; tag, manual and weekly runs still build clean
  ([#23](https://github.com/LuciferMornens/vengeance/pull/23)). Release QA waits for the queue strip
  to settle before removing a queued message and reports why a removal did not apply
  ([#24](https://github.com/LuciferMornens/vengeance/pull/24)).

## Limits

The mark covers the Engine's built-in OAuth providers. A sign-in that fails for any other reason
keeps its earlier behavior, and Engine 2's sign-ins are unchanged.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.5/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the local qualification scope.

The [qualification checkpoint](https://github.com/LuciferMornens/vengeance/blob/v0.3.5/docs/RELEASE-QUALIFICATION-0.3.5.md)
records local and CI evidence. The tag run and the published release's receipts identify the
qualified shipping bytes.
