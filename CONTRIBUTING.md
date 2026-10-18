# Contributing to Vengeance

Thanks for helping. Vengeance is a desktop app for coding agents, built on two native engines:
Engine and Engine 2. Before you change anything, read:

- [SPEC.md](SPEC.md), the product contract.
- [AGENTS.md](AGENTS.md), the working rules for the repository.
- [UPSTREAM.md](UPSTREAM.md), before you touch an engine, the Engine 2 sign-in helper or a
  compatibility path.

Vengeance is pre-1.0. For anything larger than a small fix, open an issue first, so we can agree on
the approach before you put in the work.

## Prerequisites

Every platform needs:

- **Node 24.19.0** (the version in [`.node-version`](.node-version)) with **npm 11.17** (the
  `packageManager` in [`package.json`](package.json)). CI and release builds use exactly that Node.
- **Git**.
- **Python 3**. The engine build scripts use only its standard library.
- **Rust 1.98.1** through rustup. [`rust-toolchain.toml`](rust-toolchain.toml) selects the version.
  Add the target for your machine:

  | Machine             | Rust target                 |
  | ------------------- | --------------------------- |
  | Windows x64         | `x86_64-pc-windows-gnu`     |
  | macOS Apple silicon | `aarch64-apple-darwin`      |
  | macOS Intel         | `x86_64-apple-darwin`       |
  | Linux x64           | `x86_64-unknown-linux-gnu`  |
  | Linux arm64         | `aarch64-unknown-linux-gnu` |

  For example: `rustup target add aarch64-apple-darwin`.

### Windows

- Use **Git Bash** as your shell.
- Engine 2 and the helper build with Rust's **GNU** toolchain, not MSVC. Make the GNU host the
  default before you install 1.98.1, so `rust-toolchain.toml` resolves to it:

  ```bash
  rustup set default-host x86_64-pc-windows-gnu
  rustup toolchain install 1.98.1
  ```

- Put a **MinGW-w64 GCC** on `PATH`, for example WinLibs or MSYS2's `mingw-w64-ucrt-x86_64-gcc`.
- Put **GNU `objdump`** on `PATH`, or point `OBJDUMP` at it. The build uses it to check that the
  native executables need nothing beyond Windows itself.

### macOS

- macOS 13 or newer, with the **Xcode Command Line Tools** (`xcode-select --install`). They provide
  clang, `codesign` and `otool`.
- The build scripts set `MACOSX_DEPLOYMENT_TARGET=13.0` and ad-hoc sign the native executables. No
  Apple Developer account is needed.

### Linux

- A compiler and binutils: `build-essential` and `binutils` on Debian and Ubuntu, `base-devel` on
  Arch.
- The libraries Electron needs to run, such as GTK 3, NSS and libsecret. A desktop distribution
  usually has them already.
- **glibc baseline.** Release builds run in an Ubuntu 22.04 container, and the engine build refuses
  any native executable that needs a glibc newer than 2.35, so the packages start on every supported
  distribution. On a newer distribution, Engine 2 and the helper link against your newer glibc and
  fail that check. Build them inside an Ubuntu 22.04 container, as CI does, or set
  `VENGEANCE_GLIBC_BASELINE=host` for engines you only run on your own machine. Never ship
  packages built that way; release CI checks the packaged app against glibc 2.35 again.
- On Ubuntu 24.04 and newer, AppArmor blocks the user namespaces Chromium's sandbox uses. If the dev
  app will not start, allow them for the session with
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
- To package with `npm run dist`, you also need `rpmbuild` for the rpm and `bsdtar` for the pacman
  package: `rpm` and `libarchive-tools` on Debian and Ubuntu.

## Build and run

```bash
git clone https://github.com/LuciferMornens/vengeance.git
cd vengeance
npm ci
node node_modules/electron/install.js
npm run dev
```

Electron 44 has no install script, so `npm ci` does not download its runtime;
`node node_modules/electron/install.js` does, and `npm run dev` stops with "Electron uninstall"
without it. The first run compiles both engines and the helper from source, which takes a while. On
a smaller machine, set `VENGEANCE_NATIVE_BUILD_JOBS=1` to limit build concurrency (the default is
four).

## Gates

Run these before you open a pull request:

```bash
npm run typecheck
npm run build
npm run checks
npm run shots
```

Then **open the PNGs** in `.shots/` that your change affects. The screenshot run fails only on
scenario errors and never compares pixels, so a broken layout passes unless someone looks at it.

## Engines and patches

Both engines ship as Vengeance source builds of upstream releases. `engines.lock.json` pins each
upstream revision, and `patches/` holds our changes, applied in order.

- Never edit staged payloads under `.engine-staging/bundled` or anything in `release/`. A changed
  payload is rejected; it is not trusted.
- To change native code, run `npm run engines:prepare`, edit the checkout under
  `.engine-staging/source`, and export the result as a new numbered patch with a clear purpose. Do
  not quietly change what an existing patch does.
- Give `engines.lock.json` a new build version (`+vengeance.N`) whenever shipped behavior changes,
  then rebuild with `npm run build:engines`.
- Follow the qualification steps in [UPSTREAM.md](UPSTREAM.md) on every platform the change touches.
- The UI names the engines "Engine" and "Engine 2", never by their upstream names.

## Testing safely

Your own agent accounts and sessions are never test fixtures.

- Never write to `~/.pi` or `~/.prime`, and never touch your real `settings.json`, `auth.json` or
  `models.json` during development.
- For anything that writes engine configuration, point the engines at temporary folders:
  `PI_CODING_AGENT_DIR` for Engine and `PRIME_AGENT_CODING_AGENT_DIR` for Engine 2. Better still,
  use mock mode. The QA harness does this for you; see
  [scripts/qa/README.md](scripts/qa/README.md).
- Tests against a real engine use tiny prompts, run in a temporary folder, and use `--no-session` or
  a temporary session folder.

## Pull requests

1. Branch from `main` and keep each pull request to one purpose.
2. Write commit subjects as `area: what changed`, for example `shots: cover the Linux title bar` or
   `docs: explain the glibc baseline`.
3. Fill in the pull request template, including the platforms you tested on.
4. CI must pass. It typechecks and builds, lints the workflows, builds the engines, then runs the
   checks and screenshots on Windows, macOS and Linux. Pull requests that touch packaging, engines
   or the release workflow also run a full release dry run on all five platforms.
5. The maintainer reviews every change. Screenshots of UI changes speed this up.
6. Pull requests land as one squash commit. `main` accepts no direct or force pushes: a change
   needs a pull request with every review thread resolved, a passing typecheck job and passing
   checks-and-shots jobs on all three platforms.

Vengeance uses the [Vengeance License](LICENSE.md). By opening a pull request you license your
contribution under its section 5: the Licensor, LuciferMornens, may use, license and sublicense it
on any terms, including commercial ones. Only contribute work you have the right to give, and name
any third-party code in it. Changes in `patches/` are under the MIT license of the engine they
change.

## Releases

Releases are for maintainers.

1. Set the new version in `package.json` and `package-lock.json`, and write
   `docs/RELEASE-<version>.md`.
2. Merge that change to `main`, then push the tag `v<version>`. Only maintainers can create,
   move or delete `v*` tags. The workflow rejects a tag that does not match `package.json`, so a
   prerelease sets `package.json` and `package-lock.json` to `<version>-rc.N` and pushes the
   matching tag `v<version>-rc.N`. Its builds check the same update feed as stable ones (the newest
   stable release), so they are offered the next stable release, never a newer prerelease.
3. The release workflow builds and smoke-tests all five platforms (the macOS apps are ad-hoc
   signed) and install-tests the deb, rpm and pacman packages. It then creates a **draft** release
   with every package, `SHA256SUMS` and a provenance attestation.
4. Check the draft, then publish it. Anyone can verify a download with
   `gh attestation verify <file> --repo LuciferMornens/vengeance`.
