# Vengeance development guide

Read [SPEC.md](../SPEC.md) and [AGENTS.md](../AGENTS.md) first. This is the current architecture
and development guide; it replaces the original Wave 1 handoff. Engine, helper and update changes
also require [UPSTREAM.md](../UPSTREAM.md). [README.md](../README.md) indexes current guidance and
historical qualification reports.

## Setup and commands

Use Git Bash on Windows. Node's supported minimum and all JavaScript versions are pinned in
`package.json` and `package-lock.json`; install with `npm ci`. Native engine/helper builds also
need the toolchains listed in `UPSTREAM.md`. `allowScripts` permits the approved esbuild packages.
If Electron's downloaded runtime is missing, run `node node_modules/electron/install.js`.

The stack is Electron, electron-vite, React, strict TypeScript, Tailwind v4, Radix, Motion,
Zustand and Playwright. Fonts are local Geist/Geist Mono packages. Markdown uses react-markdown,
remark-gfm, Shiki and Mermaid; ANSI output uses `src/renderer/lib/ansi.ts` and `AnsiText`.

| Command                          | Purpose                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run engines:prepare`        | Reconstruct editable, patched native source under `.engine-staging/source`.                            |
| `npm run build:engines`          | Build or verify both complete engine payloads from `engines.lock.json`.                                |
| `npm run build:auth`             | Build or verify the helper linked to the same patched Prime source.                                    |
| `npm run dev`                    | Prepare engines/helper, then start electron-vite with renderer HMR.                                    |
| `npm run typecheck`              | Check main/preload/shared and renderer/shared TypeScript.                                              |
| `npm run checks`                 | Run the fast application contract checks.                                                              |
| `npm run build`                  | Prepare engines/helper, then produce application bundles in `out/`.                                    |
| `npm run shots -- <name>`        | Run matching mock screenshot scenarios against the completed build. Omit the filter for all scenarios. |
| `npm run qa -- --only <glob>`    | Run matching application QA suites, one Node process per suite.                                        |
| `npm run qa:smoke`               | Real Engine with a local scripted provider.                                                            |
| `npm run e2e:real`               | Tiny live-provider smoke in a temporary workspace with no saved session.                               |
| `npm run e2e:tree`               | Offline Engine tree navigation with isolated configuration/history.                                    |
| `npm run icons`                  | Regenerate committed icons from `build/icon.svg`.                                                      |
| `npm run dist`                   | Build the app and package Windows NSIS plus `release/win-unpacked`.                                    |
| `npm run dist:qa -- --dir`       | Build and package the separate QA application without an installer.                                    |
| `node scripts/dist-qa.mjs --dir` | Package an already completed build under the QA identity.                                              |

Run UI suites serially, after renderer builds finish. Replacing lazy-loaded chunks beneath an open
QA window can invalidate the run. The release scripts never publish. Unpacked QA does not require
installation; its separate identity avoids sharing the normal application's profile and shortcuts.

## Engine ownership and process boundaries

Both engines default to complete Vengeance source builds. There is no automatic global-install
or PATH fallback. A missing bundle requires app repair; explicit custom locations are for
development/testing. Native self-updates are disabled; engine upgrades ship with app releases.

| Location                                                 | Responsibility                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`, `window.ts`, `app-state.ts`         | Bootstrap, single-instance behavior, native window, persisted application preferences and shutdown.                       |
| `src/main/engine/manager.ts`, `backends.ts`, `handle.ts` | Backend selection, capabilities and common session lifecycle.                                                             |
| `src/main/engine/locate.ts`, `bundled.ts`                | Engine package/runtime resolution and bundled descriptors. Bundled pi uses Electron's Node.                               |
| `src/main/engine/rpc-process.ts`                         | One pi RPC child per open session, strict LF JSONL, request correlation, backpressure and diagnostics.                    |
| `src/main/engine/sdk-host/`                              | On-demand pi SDK host for catalog, packages, keybindings and context operations.                                          |
| `src/main/features/settings/pi-modules.ts`               | Narrow typed imports from the selected pi build for main-process operations.                                              |
| `src/main/features/settings/provider-host.ts`            | pi provider/extension discovery in a separate host.                                                                       |
| `src/main/engine/prime/`                                 | Prime daemon transport, resident attachment, normalization, configuration, native session operations and guarded restart. |
| `resources/bridge/`                                      | pi extension bridge for tree, reload, tools, labels, subagents and speed operations.                                      |
| `resources/prime-auth/`                                  | Native Prime helper for authentication, saved-session branches, resources, traces and restart recovery.                   |
| `scripts/engines/`, `engines.lock.json`, `patches/`      | Reproducible engine builds, packaging verification and ordered native patches.                                            |

The pi SDK host imports individual `dist/` files, not the full SDK entrypoint. It shuts down after
12 seconds idle for background work or 60 seconds for interactive settings work. Main imports small
configuration/session modules lazily; native sign-in/sign-out additionally load the model runtime.
Provider-host and bridge files are packaged outside ASAR where their native consumers can read them.

Prime uses its own daemon/session API, helper, configuration and auth. Saved tabs detach on close;
**Background sessions** includes idle residents. **Stop session** ends the resident while retaining
saved history. Composer **Stop** ends the current turn. Temporary unsaved sessions stop when their
app handle closes and cannot restart in place. A new app build does not replace a running resident:
the UI reports running and selected engine versions and offers a guarded restart.

Prime's runtime cache is keyed by payload hash under the app's user-data directory. Do not remove
caches still referenced by residents or recovery state. The native loop, tools, queues, goals,
schedules and session formats remain owned by their respective engines.

## IPC and renderer entrypoints

`src/shared/ipc.ts` intersects feature maps in `src/shared/api/`. An invoke entry is a tuple of
arguments followed by its result. `src/main/ipc/` registers handlers, and `src/preload/index.ts`
exposes typed `window.vengeance.invoke` and `on`. Renderer callers use `src/renderer/lib/ipc.ts`.
Keep operations in their feature folder; add shared contract fields only when callers need them.

Representative engine calls (the source types are authoritative):

- `engine:create(args, agentId)` returns `AgentInfo`; the renderer chooses the ID before startup
  so early events can be attributed.
- `engine:command(agentId, command)` handles the common session protocol; `prime:command` carries
  native Prime operations. `engine:bridge` handles backend-supported bridge operations.
- `engine:describe(engine)` describes a selected backend. `engine:info` is the pi compatibility
  entrypoint; use the explicit backend call for dual-engine features.
- `engine:restart(agentId, patch?)`, `engine:dispose(agentId)` and `engine:adopt()` manage app handles.
  `engine:background-list(engine)` and `engine:background-stop(engine, nativeAgentId)` target residents.
- `engine:event`, `engine:status` and `engine:exit` are the event channels.

`src/shared/engine-types.ts` models the qualified pi protocol and the common normalized transcript.
Prime frames enter through `src/main/engine/prime/transport.ts` and are normalized by that backend's
adapter. Preserve unknown event/message/tool handling; do not route Prime session files or auth
through pi's SDK.

| Renderer location                                          | Responsibility                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `store/agents.ts`, `agent-state.ts`, `agent-reducer.ts`    | Session actions, normalized state, hydration and batched event reduction.       |
| `store/app.ts`                                             | Persisted preferences, workspaces and shell state.                              |
| `features/shell/`                                          | Layout, titlebar, workspace entrypoints and recoverable engine/runtime notices. |
| `features/chat/`, `tools/`, `composer/`                    | Transcript, tool renderers, model/reasoning/speed controls, drafts and queues.  |
| `features/engines/`                                        | Engine 2 settings, native controls and session surfaces.                        |
| `features/sessions/`, `inspector/`                         | Saved history, background residents, session trees and inspection.              |
| `features/settings/`, `launch/`, `onboarding/`, `updates/` | Backend configuration, launch/trust, first run and app/package updates.         |
| `features/extension-ui/`, `palette/`                       | Engine extension dialogs/widgets and command navigation.                        |
| `ui/`, `styles/`, `lib/motion.ts`                          | Shared primitives, tokens, themes and motion presets.                           |

Model and reasoning selection belong to the composer footer. The session header owns its title,
context/cost and session actions. Heavy surfaces and syntax/diagram rendering load lazily.
Extension dialogs expire according to the native timeout contract. These are implemented features,
not unfinished foundation stubs. Follow [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) for visual rules.

## Isolation and verification

`src/main/env.ts` reads `VENGEANCE_MOCK`, `VENGEANCE_TEST`, `VENGEANCE_NO_MICA` and
`VENGEANCE_USER_DATA`. Test mode exposes `window.__vengeanceTest` and bypasses the single-instance
lock; it does not by itself isolate engine accounts. Use the QA harness to provision temporary
HOME, profile, account, session and kernel roots. Engine uses `PI_CODING_AGENT_DIR`; Engine 2 uses
`PRIME_AGENT_CODING_AGENT_DIR`. Never develop against writable copies of real account files.

`scripts/shots/<feature>.mjs` exports `scenarios(page, helpers)` and gets a fresh mock app/profile.
The helpers include `shot`, `test`, `wait`, `app` and `MOCK_WORKSPACE`. Scenarios use public test
hooks for mock playback, workspace selection, preferences and UI state. Both engines have mock
implementations. These screenshots qualify UI behavior, not native provider compatibility.

Run `npm run typecheck`, `npm run build` and `npm run shots`; inspect the generated PNGs. Run
`npm run checks` and relevant public-boundary QA for changed behavior. Engine updates additionally
require the native and packaged matrix in `UPSTREAM.md`. [The QA guide](../scripts/qa/README.md)
documents fixture APIs, candidate hashes, real-provider limits and cleanup ownership.

Mica requires on-screen inspection; automated captures disable it. Live external sign-in and
paid-provider coverage must be reported separately from local-provider tests. Current native
integration gaps are recorded in [the engine audit](ENGINE-AUDIT-2026-10-14.md).
