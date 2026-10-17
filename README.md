<p align="center">
  <img src="build/icon.svg" width="112" alt="Vengeance logo">
</p>

<h1 align="center">Vengeance</h1>

<p align="center">
  <b>Parallel coding agents, driven beautifully.</b><br>
  Two bundled engines behind one Windows desktop app.
</p>

<p align="center">
  <a href="docs/RELEASE-0.2.15.md"><img alt="Version 0.2.15" src="https://img.shields.io/badge/version-0.2.15-FF4D3D?style=flat-square"></a>
  <img alt="Platform: Windows x64" src="https://img.shields.io/badge/platform-Windows%20x64-0078D4?style=flat-square">
  <img alt="Electron 44" src="https://img.shields.io/badge/Electron-44-47848F?style=flat-square&amp;logo=electron&amp;logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-20232A?style=flat-square&amp;logo=react&amp;logoColor=61DAFB">
  <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white">
  <a href="#license"><img alt="License: not selected" src="https://img.shields.io/badge/license-not%20selected-lightgrey?style=flat-square"></a>
</p>

<p align="center">
  <a href="#features">Features</a> &middot;
  <a href="#two-engines">Two engines</a> &middot;
  <a href="#getting-started">Getting started</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/hero-light.png">
    <img alt="Vengeance showing a session sidebar, a transcript with tool rows and a rendered Mermaid diagram, and the composer" src="docs/screenshots/hero-dark.png" width="880">
  </picture>
</p>

<p align="center">
  <sub>
    Screenshots show the interface running against the built-in mock engine with sample data, not a
    real model run. Automated captures do not show the Windows 11 Mica backdrop.
  </sub>
</p>

## Why Vengeance

Vengeance is a Windows desktop app that puts two coding-agent engines, **Engine** and **Engine 2**,
behind one interface. Run several agents at once, move a conversation from one engine to the other,
and manage models, accounts, packages and MCP servers from structured editors instead of only
hand-editing JSON. Both engines ship inside the app, so you never install either one separately.

## Features

### Run agents in parallel

- **Several agents at once.** Sessions run side by side, and live activity indicators in the sidebar
  show which ones are working.
- **Background sessions.** Closing the tab of a saved Engine 2 session leaves it running and listed
  under **Background sessions**; **Stop session** ends one explicitly, and its history stays saved.
  Temporary unsaved Engine 2 sessions stop when closed.
- **Subagents.** Engine 2 has native subagents, with each subagent's history kept beneath its parent
  session and managed under **Engine controls**. Engine delegates through a subagent extension, which
  you can find in **Settings → Extensions**. With one installed, delegated work appears in the
  transcript and in the inspector's Agents panel, where you can answer, steer or stop a worker that
  needs a decision.
- **Workspaces.** Switch workspaces from the sidebar, choose which engine new sessions use, and pick
  up from recent sessions or suggested prompts.

<p align="center">
  <a href="docs/screenshots/subagents.png"><img src="docs/screenshots/subagents.png" alt="A worker subagent asking for a decision, with Answer, Steer and Stop buttons in the Agents panel" width="880"></a>
  <br>
  <sub>With a subagent extension installed, a worker that needs a decision surfaces in the transcript and the Engine's Agents panel, with live activity beside it.</sub>
</p>

<p align="center">
  <a href="docs/screenshots/workspaces.png"><img src="docs/screenshots/workspaces.png" alt="The workspace switcher with a default engine selector for new sessions, above a start screen with suggested prompts" width="880"></a>
  <br>
  <sub>Jump between workspaces, choose the engine new sessions start with, and resume recent work.</sub>
</p>

### Choose your engine, then change your mind

- **Per workspace or per session.** Starting a session from the composer menu or the sidebar's
  new-session menu never changes the workspace default. Change the default from the workspace
  switcher's **New session default** selector or in **Settings**.
- **Switch mid-conversation.** An idle saved conversation can move between Engine and Engine 2 in the
  same tab. Your draft and the selected branch's history carry over, and the destination uses its own
  model and settings. See [Good to know](#good-to-know) for what does not transfer.

### Read exactly what the agent did

- **Tool cards.** Tool calls render as cards with diffs, an ANSI-colored console and syntax
  highlighting. Consecutive calls group into expandable activity rows.
- **A transcript that renders.** Markdown with tables and highlighted code, plus Mermaid diagrams.
- **Todo list.** When a todo extension or tool supplies a task list, it docks above the composer and
  collapses out of the way.

<p align="center">
  <a href="docs/screenshots/diff-lens.png"><img src="docs/screenshots/diff-lens.png" alt="An edit rendered as a syntax-highlighted diff with plus and minus counts, extension diagnostics beneath it, and a todo list above the composer" width="880"></a>
  <br>
  <sub>Edits render as inline diffs with added and removed line counts. Extension tools can attach their own results, such as editor diagnostics.</sub>
</p>

### Stay in control

- **Steer or queue.** While an agent runs, **Enter** steers it and **Alt+Enter** queues a follow-up.
  Press **Esc** twice, or click the stop button, to abort.
- **Composer shortcuts.** `/` opens commands, `@` picks a file and `!` runs bash. Model, reasoning and
  speed controls sit in the composer footer.
- **Command palette.** **Ctrl+K** searches sessions, models, thinking levels, slash commands, skills
  and settings.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/composer-speed.png"><img src="docs/screenshots/composer-speed.png" alt="The composer's response speed menu offering Standard, Fast and Ultrafast, above the composer footer and a docked todo list" width="100%"></a>
      <br>
      <b>Model, thinking and speed</b><br>
      <sub>Pick the model, thinking level and response speed without leaving the composer. Both engines offer Fast and Ultrafast where the model supports them.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/command-palette.png"><img src="docs/screenshots/command-palette.png" alt="The command palette listing suggested actions, open sessions and session actions such as fork and clone" width="100%"></a>
      <br>
      <b>Command palette</b><br>
      <sub>Press Ctrl+K to switch sessions, change models, compact context, fork, clone or open settings.</sub>
    </td>
  </tr>
</table>

### Inspect and manage sessions

- **Inspector.** The right panel has **Overview** (context, cost and tokens), **Branches** (the
  session tree), **Files** and **Timeline** tabs for both engines. Engine sessions add **Agents**,
  **Tools** (choose which tools the model is offered in this session) and **Extensions** tabs.
  Engine 2 sessions have an **Engine controls** button instead, which opens goals, schedules,
  subagents and the rest of the Engine 2 session controls.
- **Session actions.** Fork, clone, rename, export, import, share or delete a session.
- **Sharing.** Engine sharing follows the native Auto, GitHub gist or Radius preference, and a
  consent dialog names the actual destination before anything is uploaded.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/inspector-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/inspector-light.png">
    <img alt="The Overview inspector beside a conversation, showing context use, session cost, model, tokens and compaction" src="docs/screenshots/inspector-dark.png" width="880">
  </picture>
  <br>
  <sub>The Overview tab keeps context use, cost, model, tokens and compaction in view. The dark and light captures show the same screen in different sample states.</sub>
</p>

### Configure visually

- **Structured settings.** Editors for models, providers and accounts, custom models, agent
  behavior, extensions, packages, resources, MCP servers, sessions and context, and keyboard
  shortcuts, with a Raw JSON editor when you want the file itself.
- **Extension gallery (Engine).** **Settings → Extensions** browses community packages from the
  public npm registry. Search or browse topics, read what a package adds, and install it for every
  project or only the open one. **Add your own** installs an extension file or package folder. The
  gallery is read-only until you click **Install** and honors offline mode. Installed packages are
  managed in **Settings → Packages**.
- **Abliteration models (Engine).** All three Abliteration models are included. Connect in
  **Settings → Providers & accounts → Abliteration**, or supply `ABLIT_KEY` in the launch
  environment. Abliterated Model Large V2 offers Minimal, Low, Medium, High, Extra high and Max
  reasoning effort.

<p align="center">
  <a href="docs/screenshots/settings-models.png"><img src="docs/screenshots/settings-models.png" alt="Settings, Models: default model, default thinking level, response speed for new sessions and per-model thinking levels, with the settings navigation alongside" width="880"></a>
  <br>
  <sub>The Models editor sets the default model, thinking level and response speed, with the other settings sections listed alongside.</sub>
</p>

### Make it yours

- **Themes.** Dark **Obsidian**, light **Bone**, or follow Windows.
- **Accents.** Ember, violet, cyan, lime, rose or mono, plus text size, density and motion controls.
- **Window.** A frameless window with the Windows 11 Mica backdrop where supported. Geist fonts are
  bundled locally.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="docs/screenshots/themes-obsidian.png"><img src="docs/screenshots/themes-obsidian.png" alt="The General settings page in the dark Obsidian theme, with theme cards, accent swatches and text size" width="100%"></a>
      <br>
      <sub>Obsidian</sub>
    </td>
    <td width="50%" valign="top">
      <a href="docs/screenshots/themes-bone.png"><img src="docs/screenshots/themes-bone.png" alt="The General settings page in the light Bone theme, with theme cards, accent swatches and text size" width="100%"></a>
      <br>
      <sub>Bone</sub>
    </td>
  </tr>
</table>

## Two engines

Vengeance bundles two coding-agent engines and presents them as **Engine** and **Engine 2**. Each
has its own agent loop, tools, sign-in, settings and saved sessions. The chat interface, composer,
command palette and inspector are shared.

|            | Engine                                                                                      | Engine 2                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Built from | [pi](https://github.com/earendil-works/pi) `v1.3.0`, build `1.3.0+vengeance.1`              | [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) `v0.10.0`, build `0.10.0+vengeance.9`                                                  |
| Runs on    | Electron's Node, so no separate Node install                                                | A native executable that includes its Python kernel package, skills and catalogs                                                                       |
| Sessions   | One process per open session                                                                | Saved resident sessions that survive closing a tab and are listed under **Background sessions**                                                        |
| Highlights | Extension gallery, extension dialogs and widgets, project-trust dialog, Abliteration models | Native subagents, goals, schedules (heartbeat and cron), side questions, trace inspection and export, native Fast and Ultrafast OpenAI speed transport |
| Sign-in    | Its own accounts and settings                                                               | Its own accounts and settings, including subscription sign-in for Anthropic, GitHub Copilot, OpenAI Codex and xAI                                      |

<p align="center">
  <a href="docs/screenshots/engine-2-controls.png"><img src="docs/screenshots/engine-2-controls.png" alt="The Engine 2 session controls dialog on the Goal tab, with tabs for Autonomy, Schedule, Refine, Subagents, Factory, Context, Traces and Side question" width="640"></a>
  <br>
  <sub>Engine 2 session controls: goals, autonomy, schedules, refinement, subagents, factory runs, context, traces and side questions.</sub>
</p>

In practice:

- Each engine keeps its own model choice, credentials, settings and saved-session format. Credentials
  are never copied between engines, and secrets are masked before they reach the interface.
- Response speed (Fast and Ultrafast) is available in both engines wherever the model offers it.
- Changing a workspace's default engine does not convert existing sessions.
- Both engines are built from source by Vengeance. Upstream revisions, build versions and the ordered
  patches are pinned in [engines.lock.json](engines.lock.json), and the patches live in
  [patches/](patches). Engines ship with the app and update with it. There is no PATH fallback, and
  the engines' own self-update is disabled.

## Getting started

> [!NOTE]
> There are no published releases yet, so there is no installer to download. Vengeance builds from
> source, as described below.

### Requirements

To run Vengeance:

- Windows x64. The Mica backdrop needs Windows 11 22H2 or newer; the minimum supported Windows
  version is not declared.
- Access to a model provider: an API key or a subscription sign-in. Vengeance does not supply models.
- No Node, Rust or Python install is needed to load the engines. Package installation and developer
  tools keep their own prerequisites, such as npm, Git or Bash, and Engine 2's native tools may fetch
  their own language environments on first use.

To build from source:

- Git Bash on Windows, Node `>=22.19.0` with npm, Git and Python.
- Rust and Cargo 1.98.1 with the `x86_64-pc-windows-gnu` target, and GNU `objdump` on `PATH`
  (`OBJDUMP` can point at it). See [UPSTREAM.md](UPSTREAM.md) for the native toolchain details.

### Build and run

From Git Bash:

```bash
git clone https://github.com/LuciferMornens/vengeance.git
cd vengeance
npm ci
npm run dev
```

`npm run dev` prepares both engines and the Engine 2 sign-in helper, then starts the app with hot
reload. The first run compiles the native engines from source and can take several minutes. On a
smaller machine, set `VENGEANCE_NATIVE_BUILD_JOBS=1` to limit build concurrency; the default is four.
If Electron's runtime is missing, run `node node_modules/electron/install.js`.

When the app opens, add a provider under **Settings → Providers & accounts**. Each engine has its own
accounts and settings.

### Build the Windows installer

```bash
npm run dist
```

This builds the app and an NSIS installer at `release/Vengeance-Setup-<version>.exe`. The installer
is per-user, lets you choose the install directory, creates desktop and Start Menu shortcuts, and
keeps your app data when you uninstall. Build scripts never publish a release. For isolated packaged
QA, run `npm run dist:qa -- --dir`, which packages the app under a separate identity without an
installer.

## Good to know

- **Status.** Vengeance is pre-1.0. [SPEC.md](SPEC.md) is a contract, not a claim of full parity with
  every native engine operation. Known gaps include no desktop UI for the native inter-agent inbox,
  `resume_queue` or queue reordering, no dashboard for native background shell jobs, no fully live
  reload for Engine 2, and unqualified synchronization with external clients. See the
  [engine audit](docs/ENGINE-AUDIT-2026-10-14.md).
- **Engine 2 updates.** Installing a newer app does not replace a running Engine 2 resident. Its
  session notice offers an explicit, guarded restart, and **Close tab** leaves saved residents
  available in **Background sessions**.
- **Reconnects.** After a disconnect, Engine 2 restores committed history and its busy and Stop state
  immediately. Partially streamed text from an unfinished turn is not guaranteed to replay.
- **Switching engines.** A recovery copy stays with the source engine. Native goals, schedules and
  child workers do not transfer, and nonempty ephemeral sessions cannot switch.
- **Subagent histories.** Engine 2 subagent histories appear beneath their native parent, with
  accessible orphan histories when the parent is outside the current view. Independent sessions and
  same-depth forks stay separate.
- **Sharing.** Radius links use organization visibility.
- **Trust.** Engine has an explicit project-trust dialog. Engine 2 has no per-project trust decisions
  and no extension dialogs.
- **Performance.** Figures in the release notes are local fixture measurements, not guarantees.

## Development

Vengeance is Electron with electron-vite, React, strict TypeScript, Tailwind CSS 4, Radix, Motion,
Zustand and Playwright. Exact versions are pinned in [package.json](package.json). Use Git Bash and
install with `npm ci`.

Before you finish a change, run the gates in order and open the screenshots:

```bash
npm run typecheck
npm run checks
npm run build
npm run shots
```

`npm run shots` runs mock-engine screenshot scenarios against the completed build and writes PNGs to
`.shots/`, which Git ignores. Finish renderer builds before launching UI QA, and run GUI suites
serially. Read [AGENTS.md](AGENTS.md) and [SPEC.md](SPEC.md) before changing anything, and
[UPSTREAM.md](UPSTREAM.md) before touching an engine, helper or compatibility path.

<details>
<summary><b>All npm scripts</b></summary>

| Command                                     | Purpose                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`                               | Prepare engines and helper, then start electron-vite with renderer hot reload.           |
| `npm run build`                             | Prepare engines and helper, then write application bundles to `out/`.                    |
| `npm run dist`                              | Build the app and a Windows NSIS installer in `release/`. Never publishes.               |
| `npm run dist:qa -- --dir`                  | Package an unpacked app under a separate QA identity, with no installer.                 |
| `npm run engines:prepare`                   | Reconstruct editable, patched upstream checkouts under `.engine-staging/source`.         |
| `npm run build:engines`                     | Build or verify both engine payloads from `engines.lock.json`.                           |
| `npm run build:auth`                        | Build or verify the Engine 2 sign-in helper.                                             |
| `npm run typecheck`                         | Type-check main, preload and shared code, then renderer and shared code.                 |
| `npm run checks`                            | Run the fast application contract checks.                                                |
| `npm run shots`                             | Run mock-engine screenshot scenarios. Add a name to filter them.                         |
| `npm run qa`, `npm run qa:smoke`            | Run application QA suites. `qa:smoke` uses the real Engine with a scripted provider.     |
| `npm run e2e:real`                          | Tiny live-provider smoke test in a temporary workspace. Needs provider access.           |
| `npm run e2e:packaged`                      | The same smoke test against the unpacked packaged app. Needs `npm run dist` first.       |
| `npm run e2e:bridge`, `e2e:mcp`, `e2e:tree` | Real-engine checks for the bridge, MCP reconnects and session-tree navigation.           |
| `npm run icons`                             | Regenerate committed icons from `build/icon.svg`.                                        |
| `npm run perf`                              | Measure the performance footprint. Needs the QA package from `npm run dist:qa -- --dir`. |

There is no `npm test`, `npm start` or lint script.

</details>

## Documentation

| Document                                                                                           | Purpose                                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [SPEC.md](SPEC.md)                                                                                 | Product and architecture contract; requirements are not a full-parity completion claim. |
| [AGENTS.md](AGENTS.md)                                                                             | Repository working rules and required gates.                                            |
| [Development guide](docs/FOUNDATION.md)                                                            | Setup, commands, current architecture and process ownership.                            |
| [Design system](docs/DESIGN-SYSTEM.md)                                                             | Tokens, shared components and visual conventions.                                       |
| [Upstream maintenance](UPSTREAM.md)                                                                | Engine reconstruction, patch rebasing and release qualification.                        |
| [Engine patch guide](patches/pi/README.md) / [Engine 2 patch guide](patches/prime-agent/README.md) | Native changes and distribution contracts.                                              |
| [Native helper](resources/prime-auth/README.md)                                                    | Engine 2 sign-in helper build, protocols and dependency updates.                        |
| [QA harness](scripts/qa/README.md)                                                                 | Temporary accounts, local providers, packaged tests and native transitions.             |

The app version is defined in [package.json](package.json).

### Release notes

**Latest: [Vengeance 0.2.15](docs/RELEASE-0.2.15.md)** covers the changes, checks and artifact hashes
for the current version. It is a report on local builds, not a download.

<details>
<summary><b>Qualification history</b></summary>

These reports describe the exact versions, hashes and observations at their stated checkpoints.
They are evidence, not current installation status or promises that local generated artifacts still
exist. Use the lockfile and current guides for maintenance instructions.

- [Release 0.2.14](docs/RELEASE-0.2.14.md): stable engine updates and Engine 2 subagent families.
- [Release 0.2.13](docs/RELEASE-0.2.13.md): native conversation handoff between engines.
- [Release 0.2.12](docs/RELEASE-0.2.12.md): conversation deletion, workspace navigation and long histories.
- [Release 0.2.11](docs/RELEASE-0.2.11.md): native Abliteration models and full Large V2 reasoning.
- [Release 0.2.10](docs/RELEASE-0.2.10.md): collapsible Engine todo list above the composer.
- [Release 0.2.9](docs/RELEASE-0.2.9.md): native OpenAI compaction keeps task continuation;
  docked Engine todo list.
- [Release 0.2.8](docs/RELEASE-0.2.8.md): responsive shell and composer layout; retained release baseline.
- [Release 0.2.7](docs/RELEASE-0.2.7.md): Engine 2 model isolation, native settings merges and
  resident session controls.
- [Engine audit — 14 October 2026](docs/ENGINE-AUDIT-2026-10-14.md): upstream comparison, parent-model
  isolation, concurrent settings preservation, local checkout synchronization and remaining gaps.
- [Engine 2 stable-base audit — 16 October 2026](docs/PRIME-STABLE-AUDIT-2026-10-16.md): upstream
  release identity and why the locked stable base was kept.
- [OpenAI native compaction](docs/openai-native-compaction.md): the compaction-trigger correction
  for both engines.
- [Resident-session update behavior — 0.2.6](docs/ENGINE2-RESIDENT-SESSIONS.md): live versus selected
  versions, capability lookup, Close tab and Stop session.
- [Image capabilities — 0.2.6](docs/ENGINE2-IMAGE-CAPABILITIES.md): native model switches, generated
  prompts and Python image bindings.
- [Native qualification — 0.2.5](docs/NATIVE-QUALIFICATION-0.2.5.md): Windows runtime fixes and
  isolated native workspace qualification.
- [Engine 2 speed — 0.2.4](docs/ENGINE2-SPEED-0.2.4.md): native Fast/Ultrafast transport and eligibility.
- [Extension compatibility — 0.2.3](docs/EXTENSION-COMPATIBILITY-0.2.3.md): upstream SDK version identity.
- [Bundled engines — 0.2.2](docs/BUNDLED-ENGINES-0.2.2.md): initial source-built engine distribution.

</details>

## License

No license has been selected for Vengeance, so all rights are reserved. [package.json](package.json)
declares `"license": "UNLICENSED"` and marks the package private, and there is no `LICENSE` file at
the repository root. [patches/prime-agent/LICENSE](patches/prime-agent/LICENSE) is the upstream MIT
license that ships with the Engine 2 patch series. The bundled engines and their dependencies keep
their own licenses, which travel with each runtime (see [UPSTREAM.md](UPSTREAM.md)).

## Acknowledgements

Engine is built from [pi](https://github.com/earendil-works/pi) by earendil-works, and Engine 2 from
[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) by PrimeIntellect-ai. Vengeance is an
independent desktop app; building on these projects does not imply endorsement by their authors.
