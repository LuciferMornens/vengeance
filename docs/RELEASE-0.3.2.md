# Vengeance 0.3.2

Vengeance 0.3.2 uses less memory and stays responsive with long sessions, many open tabs and fast
streaming. Nothing changes in how you use it. All packages are built from this tag by the release
workflow; the checks it runs are listed at the end.

**On 0.3.1, update in the app.** The Vengeance card in **Settings → Updates** offers 0.3.2. The
Windows installer and the AppImage download and install it themselves; the macOS apps and the deb,
rpm, pacman and tar.gz packages tell you about it and open this page. **On 0.3.0, install this
release by hand**, as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.2/docs/RELEASE-0.3.1.md)
explain: download the package for your system below and install it over 0.3.0; settings, sessions
and sign-ins stay.

## Downloads

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.2.exe`               |
| macOS Apple silicon | `Vengeance-0.3.2-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.2-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Requirements and first-launch steps are the same as for
[0.3.0](https://github.com/LuciferMornens/vengeance/blob/v0.3.2/docs/RELEASE-0.3.0.md#first-launch),
and the [install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.2/README.md#install)
has every command. Check a download against `SHA256SUMS`, or confirm the release workflow built it
with `gh attestation verify <file> --repo LuciferMornens/vengeance`.

## What's new

- **Settings no longer leaves memory behind.** The two helper processes Settings starts now exit
  about a second and a half after you close it, instead of staying up to a minute; they held about
  114 MiB. The helper that lists models from extensions does not start at all when no extension of
  your own is enabled.
- **Streaming is lighter.** Code blocks in a streaming answer used to be rebuilt on every update; now
  they stay in place, and plain code renders with fewer page elements. After streaming a long answer
  with code, the window's page memory fell from 71.6 MiB to 13.4 MiB. The diagram cache is bounded,
  and diagrams share one theme watcher.
- **Long sessions and many tabs stay quick.** Switching back to an open tab reuses its transcript
  instead of rebuilding it, and a new turn in a long session is built from the last turn on, not from
  the start. Bursts of tool output are merged before they reach the screen, and large tool-call
  arguments are parsed less often while they stream. The sidebar, the title bar and the Engine 2
  session families no longer redraw on every streamed token.
- **Hidden things do no work.** Collapsed tool rows work out their diffs, previews and search
  results only when you open them. The inspector does nothing while it is closed, and the closed
  model picker and slash menu prepare nothing.
- **A smaller main process.** The main bundle is minified and leaves out the modules only mock mode
  uses: 322 kB instead of 772 kB. A starting Engine is no longer asked for its state twice. The
  session history skips the lines of past sessions it does not need, and **@** file search keeps a
  compact list of a workspace's files that it drops once it goes stale.
- **Engine 2.** A streaming tool call no longer re-sends its end event with every later token. The
  Engine 2 update check no longer copies and probes the runtime at startup while you do not use
  Engine 2; it starts as soon as a workspace or session uses it.

### Measured on Windows x64

`scripts/perf/footprint.mjs` measured packaged builds from before and after the performance pass.
Memory is counted the way Task Manager counts it (private working set), for Vengeance's own
processes; the Engine's processes did not change.

| Measure                                                   | Before    | After     |
| --------------------------------------------------------- | --------- | --------- |
| After a driven session (streaming, tools, tabs, Settings) | 503.6 MiB | 344.3 MiB |
| Page memory after streaming a long answer with code       | 71.6 MiB  | 13.4 MiB  |
| A 60-turn session, 6 idle tabs and 150 past sessions      | 182.9 MiB | 161.8 MiB |
| Main bundle                                               | 772.1 kB  | 322.2 kB  |

The driven session runs under the QA harness, which adds its own overhead, so compare its numbers
only with each other. Streaming frame times stayed the same.

## Known limits

The known limits of [0.3.0](https://github.com/LuciferMornens/vengeance/blob/v0.3.2/docs/RELEASE-0.3.0.md#known-limits)
still apply. Among them: the macOS apps cannot update themselves until they carry an Apple Developer
ID signature, and macOS and Linux builds have been checked on GitHub's runners but not yet by hand
on a physical Mac or on Hyprland. The measurements above are from Windows x64 only.

## How this release was checked

- **CI** on the release commit: typecheck, build and workflow lint, then the app's contract checks
  and every screenshot scenario on Windows x64, macOS arm64 and Linux x64, with engines built the
  way releases build them.
- **The release workflow** builds each of the five platforms on its own runner and, before it
  creates the release, checks the baked update feed and `latest` channel, the glibc 2.35 baseline on
  Linux, the macOS signatures, a smoke test of each packaged app, and installs of the deb, rpm and
  pacman packages, as for 0.3.1.
- **The performance pass** was measured with the footprint harness above. A code review of the pass
  then fixed what it found before release: the inspector blanking while it slid shut, a picked
  command with a required argument not completing, code fences indented by up to three spaces not
  closing, a trailing blank line disappearing from highlighted code, and edit counts on a tool row
  that could differ from its diff. The figures above come from the pass itself; the review fixes
  passed the contract checks and every screenshot scenario on Windows x64.
