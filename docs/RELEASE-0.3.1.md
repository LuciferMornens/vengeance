# Vengeance 0.3.1

Vengeance 0.3.1 fixes app self-update and adopts the Vengeance License. All packages are built from
this tag by the release workflow; the checks it runs are listed at the end.

**On 0.3.0, install this release by hand.** 0.3.0's updater fails before it reaches the update feed,
so it shows an error on the Vengeance card in **Settings → Updates** and never offers 0.3.1. Download
the package for your system below and install it over 0.3.0; settings, sessions and sign-ins stay.
From 0.3.1 on, updates arrive in the app again.

## Downloads

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.1.exe`               |
| macOS Apple silicon | `Vengeance-0.3.1-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.1-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Requirements and first-launch steps are the same as for
[0.3.0](https://github.com/LuciferMornens/vengeance/blob/v0.3.1/docs/RELEASE-0.3.0.md#first-launch),
and the [install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.1/README.md#install)
has every command. Check a download against `SHA256SUMS`, or confirm the release workflow built it
with `gh attestation verify <file> --repo LuciferMornens/vengeance`.

## What's new

- **App updates work again.** In 0.3.0 the Vengeance card in **Settings → Updates** showed
  "Cannot set properties of undefined (setting 'logger')" and no update was found. The packaged app
  now loads its updater correctly. The Windows installer and the AppImage download and install new
  versions themselves; the macOS apps and the deb, rpm, pacman and tar.gz packages tell you about a
  new version and open its release page.
- While an update downloads or waits to be installed, a new check no longer starts over, and a
  failed download shows its error on the card.
- **License.** Vengeance is released under the [Vengeance License 1.0](https://github.com/LuciferMornens/vengeance/blob/v0.3.1/LICENSE.md).
  The [README](https://github.com/LuciferMornens/vengeance/blob/v0.3.1/README.md#license) sums it up;
  the license text has the full terms. Every package now ships `LICENSE.md` in its resources, and
  **About** names the license. The bundled engines and the patches to them keep their MIT licenses.

## Known limits

The known limits of [0.3.0](https://github.com/LuciferMornens/vengeance/blob/v0.3.1/docs/RELEASE-0.3.0.md#known-limits)
still apply. Among them: the macOS apps cannot update themselves until they carry an Apple Developer
ID signature, and macOS and Linux builds have been checked on GitHub's runners but not yet by hand
on a physical Mac or on Hyprland.

## How this release was checked

- **CI** on the release commit: typecheck, build and workflow lint, then the app's contract checks
  and every screenshot scenario on Windows x64, macOS arm64 and Linux x64, with engines built the
  way releases build them.
- **The release workflow** builds each of the five platforms on its own runner and, before it
  creates the release, checks the baked update feed and `latest` channel, the glibc 2.35 baseline on
  Linux, the macOS signatures, a smoke test of each packaged app (which must ship `LICENSE.md`), and
  installs of the deb, rpm and pacman packages, as for 0.3.0.
- **The updater fix** has a contract check against the installed electron-updater package and an
  application QA suite that runs the built app against a local update feed: it reports up to date
  for the current version and offers a newer one. Both passed on Windows x64.
