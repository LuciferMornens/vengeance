# Security policy

## Supported versions

Vengeance is pre-1.0. Only the **latest release** gets security fixes. Fixes ship in a new release
rather than as patches to older ones.

| Version           | Supported   |
| ----------------- | ----------- |
| Latest release    | Yes         |
| Any older release | No          |
| Unreleased `main` | Best effort |

## Reporting a vulnerability

Report vulnerabilities **privately** through
[GitHub's private vulnerability reporting](https://github.com/LuciferMornens/vengeance/security/advisories/new).
Do not open a public issue, pull request or discussion for a security problem.

Please include:

- The Vengeance version, the platform (for example macOS Apple silicon or Linux arm64) and the
  package type (for example NSIS, DMG, AppImage, deb or a source build).
- Which engine is involved, if any: Engine, Engine 2 or neither.
- Steps to reproduce, or a proof of concept.
- The impact as you understand it: what an attacker gains, and what they need first.

Never include real API keys, tokens or session files. If a secret is part of the problem, describe
it and use a revoked or test value.

## Scope

In scope:

- The Vengeance app: its main process, preload, renderer and the IPC between them.
- The engine builds that Vengeance ships, as patched and packaged here, and the Engine 2 sign-in
  helper.
- How Vengeance stores credentials and settings, and how it starts engine processes.
- Self-update: the update feed, the update files and how the app checks and installs updates.
- The installers and packages, and the workflows in `.github/workflows` that build and publish them.

Out of scope:

- Problems in upstream pi or Prime Agent that our patches do not introduce. Report them upstream,
  and tell us too if a Vengeance release is affected.
- What an agent does with tools and permissions the user granted it, unless Vengeance bypasses a
  confirmation, trust decision or setting that should have stopped it.
- Attacks that need control of the user's account or machine already.
- Warnings shown because the builds are unsigned (Windows) or ad-hoc signed (macOS).

## What to expect

This project has a single maintainer, so these are targets, not guarantees:

- An acknowledgement within 7 days.
- An initial assessment, including whether we consider it in scope, within 14 days.
- A fix in the next release for confirmed issues, coordinated with you before the details are made
  public. We credit reporters in the advisory unless you prefer not to be named.

## Verifying a download

Every release lists `SHA256SUMS` and has a build provenance attestation. To check a package:

```bash
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify <package> --repo LuciferMornens/vengeance
```
