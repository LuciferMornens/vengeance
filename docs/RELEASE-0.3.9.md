# Vengeance 0.3.9

Vengeance 0.3.9 adds OrcaRouter to both engines and moves both engines to their newest stable
releases, with every local fix carried over.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.9.exe`               |
| macOS Apple silicon | `Vengeance-0.3.9-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.9-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.9/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1 to 0.3.8, **Settings → Updates** offers the next published release. The Windows installer
and Linux AppImage can download and install updates; macOS and other Linux packages open the
release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.9/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **OrcaRouter on both engines.** Kimi K3.1 Pro Abliterated / Uncensored
  (`orca/orcacyber-k3.1-pro`) is included, with a 1M-token context, up to 943K output, images, tools
  and Off, Low, High and Max reasoning effort. Connect in **Settings → Providers & accounts →
  OrcaRouter**, or supply `ORCAROUTER_API_KEY` in the launch environment. The model is gated to
  OrcaRouter's Security Research tier.
- **Engine `1.5.0+vengeance.1`.** Built from pi `v1.5.0`. It brings GPT-6.1 Terra, faster streaming
  of large tool calls, correct Kimi K3.1 Pro request settings on Kimi Coding, Moonshot and OpenCode
  Go, and smaller resized photos.
- **Engine 2 `0.10.2+vengeance.1`.** Built from Prime Agent `v0.10.2`, with its model catalog at the
  newest revision. Bedrock, Azure OpenAI Responses and Gemini requests that failed on 0.10.1 work
  again, Claude Haiku 5.x uses adaptive thinking, and OpenAI Codex prompt caching is restored.
- **Engine 2 model overrides.** A `modelOverrides` entry without its own `compat` used to erase a
  built-in model's compatibility settings. It now keeps them.

## Limits

With reasoning Off, Kimi K3.1 Pro Abliterated tends to write its deliberation into the visible
answer and can repeat tool calls, so prefer Low or higher. OrcaRouter accepts any effort value, even
a made-up one, so the ladder follows its documented `none`, `low`, `high` and `max`. On small prompts
only `none` made a measurable difference (checked on 6 November 2026). A saved Minimal, Medium or
Extra high moves to Low, High or Max. OrcaRouter lists no cache write price, so the cost estimate
uses the input price. The API also takes video, which neither engine can attach.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.9/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the release qualification scope. The tag run and the published release's receipts
identify the qualified shipping bytes.
