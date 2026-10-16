# Vengeance

Vengeance is a Windows-first desktop coding-agent app with two bundled, customized native engines.
The interface calls pi **Engine** and Prime Agent **Engine 2**. Each backend owns its own agent loop,
tools, authentication, configuration and saved sessions.

The app version is defined in [package.json](package.json). Engine revisions, distribution versions
and ordered patches are pinned in [engines.lock.json](engines.lock.json); engines update with the app.
The current native builds are Engine `1.2.0+vengeance.4` and Engine 2 `0.10.0+vengeance.6`.

Engine includes all three Abliteration models. Connect in **Settings → Providers & accounts →
Abliteration**, or supply `ABLIT_KEY` in the launch environment. Abliterated Model Large V2 offers
Minimal, Low, Medium, High, Extra high and Max reasoning effort.

Latest local release: [Vengeance 0.2.12 — changes, checks and artifact hashes](docs/RELEASE-0.2.12.md).

## Current guides

| Document                                                                                           | Purpose                                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [SPEC.md](SPEC.md)                                                                                 | Product and architecture contract; requirements are not a full-parity completion claim. |
| [AGENTS.md](AGENTS.md)                                                                             | Repository working rules and required gates.                                            |
| [Development guide](docs/FOUNDATION.md)                                                            | Setup, commands, current architecture and process ownership.                            |
| [Design system](docs/DESIGN-SYSTEM.md)                                                             | Tokens, shared components and visual conventions.                                       |
| [Upstream maintenance](UPSTREAM.md)                                                                | Engine reconstruction, patch rebasing and release qualification.                        |
| [Engine patch guide](patches/pi/README.md) / [Engine 2 patch guide](patches/prime-agent/README.md) | Native changes and distribution contracts.                                              |
| [Native helper](resources/prime-auth/README.md)                                                    | Prime helper build, protocols and dependency updates.                                   |
| [QA harness](scripts/qa/README.md)                                                                 | Temporary accounts, local providers, packaged tests and native transitions.             |

From Git Bash, install dependencies with `npm ci`, then use `npm run dev` or `npm run build`.
Both commands prepare the engines and helper. Native build prerequisites are in `UPSTREAM.md`.
Run `npm run typecheck`, `npm run checks`, `npm run build`, then `npm run shots`; open the PNGs.
Finish renderer builds before launching UI QA, and run GUI suites serially.

`npm run dist` creates the Windows installer in `release/`. For isolated packaged QA, use
`npm run dist:qa -- --dir`; no installer launch is needed. Build scripts never publish releases.

## Qualification history

These reports describe the exact versions, hashes and observations at their stated checkpoints.
They are evidence, not current installation status or promises that local generated artifacts still
exist. Use the lockfile and current guides for maintenance instructions.

- [Release 0.2.11](docs/RELEASE-0.2.11.md): native Abliteration models and full Large V2 reasoning.
- [Release 0.2.10](docs/RELEASE-0.2.10.md): collapsible Engine todo list above the composer.

- [Release 0.2.9](docs/RELEASE-0.2.9.md): native OpenAI compaction keeps task continuation;
  docked Engine todo list.
- [Release 0.2.8](docs/RELEASE-0.2.8.md): responsive shell and composer layout; retained release baseline.
- [Release 0.2.7](docs/RELEASE-0.2.7.md): Engine 2 model isolation, native settings merges and
  resident session controls.
- [Engine audit — 14 October 2026](docs/ENGINE-AUDIT-2026-10-14.md): upstream comparison, parent-model
  isolation, concurrent settings preservation, local checkout synchronization and remaining gaps.
- [Resident-session update behavior — 0.2.6](docs/ENGINE2-RESIDENT-SESSIONS.md): live versus selected
  versions, capability lookup, Close tab and Stop session.
- [Image capabilities — 0.2.6](docs/ENGINE2-IMAGE-CAPABILITIES.md): native model switches, generated
  prompts and Python image bindings.
- [Native qualification — 0.2.5](docs/NATIVE-QUALIFICATION-0.2.5.md): Windows runtime fixes and
  isolated native workspace qualification.
- [Engine 2 speed — 0.2.4](docs/ENGINE2-SPEED-0.2.4.md): native Fast/Ultrafast transport and eligibility.
- [Extension compatibility — 0.2.3](docs/EXTENSION-COMPATIBILITY-0.2.3.md): upstream SDK version identity.
- [Bundled engines — 0.2.2](docs/BUNDLED-ENGINES-0.2.2.md): initial source-built engine distribution.

Installing a newer app does not replace a running Engine 2 resident. Its session notice offers an
explicit guarded restart; **Close tab** leaves saved residents available in **Background sessions**.

The composer engine menu can switch an idle saved conversation between Engine and Engine 2 while
keeping the current tab, draft and selected branch's history. The destination uses its own model and
settings. A recovery copy stays with the source engine; native goals, schedules and child workers do
not transfer. Nonempty ephemeral sessions cannot switch. The same menu and the sidebar's new-session
menu can start a conversation with either engine without changing the workspace default.
