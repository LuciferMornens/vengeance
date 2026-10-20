# VENGEANCE — Master Spec

Vengeance is a premium **cross-platform native desktop app** (Electron) for AI coding agents, shipped for
Windows x64, macOS (Apple silicon and Intel) and Linux x64/arm64. Each platform follows its own window,
menu, packaging and update conventions (§1 rule 4, §2.4, §3.7); Windows behavior is the reference, and
supporting another platform never changes it. It ships two customized native backends: **pi** and
**Prime Agent**. The product must never _look_ like a wrapper around a CLI: no backend branding in the UI,
no terminal aesthetics in chrome. The UI calls pi **"Engine"** and Prime Agent **"Engine 2"**; engine
selectors, settings and session controls use those labels. Internally (code, comments, development
documentation) use pi and Prime freely.

Goal: so smooth and so beautiful that people get hooked. Full native capability coverage and visual editing
of models, settings, providers, packages, resources and MCP are product requirements. This spec defines
the contract, not a claim that every native feature has shipped. See [README.md](README.md) for the
current documentation and [the engine audit](docs/ENGINE-AUDIT-2026-10-14.md) for known integration gaps.
Section 10 supersedes pi-only assumptions throughout this document: each backend keeps its own native
protocol, configuration, authentication and session behavior.

---

## 1. Hard rules

1. **The selected native backend owns every agent operation.** Never reimplement its agent loop, tools,
   compaction, sessions, model calls, extensions, skills, prompt templates, slash commands or auth.
   Vengeance builds the native engines, adapts their public protocols and renders them.
2. **Full parity:** anything the pi CLI/TUI can do must be doable in the GUI (prompting, steer/follow-up,
   abort, model + thinking switching, model cycling scopes, `!bash`, compaction, sessions resume/fork/clone/tree
   navigation, rename, export HTML, extensions + their UI requests, slash/extension commands, skills, prompt
   templates, packages install/remove/update, `pi config` resource toggles, auth/login, MCP, every
   `settings.json` key).
3. **The GUI adds visual editing** for all of it. Hand-editing JSON should never be required (but an
   "Edit raw JSON" escape hatch is welcome for advanced users).
4. **Desktop, not browser.** Native frameless window, single-instance, tray-less, proper app icon, packaged
   by electron-builder; closing the window quits the app on every platform. No browser-y UI (no visible
   URL-ish things, no default focus rings, no text-selection on chrome, no default scrollbars, no white
   flash on launch). Each platform keeps its own window conventions:
   - **Windows:** Windows 11 Mica material (22H2 or newer; solid elsewhere), native caption buttons via
     `titleBarOverlay` (snap layouts must work), per-user NSIS installer.
   - **macOS:** hidden titlebar with the native traffic lights inset at its left edge, the standard app,
     Edit and Window menus (system editing shortcuts; nothing reloads, opens developer tools or closes the
     window), folders dropped on the Dock icon open as workspaces, dmg and zip per architecture.
   - **Linux:** Electron's caption buttons via `titleBarOverlay` on floating desktops and no client-side
     controls on tiling compositors (Hyprland, sway, niri, i3 and the like), native Wayland in Wayland
     sessions (Electron's default; X11 elsewhere) with Wayland input methods, app ID `vengeance`, AppImage,
     deb, rpm and tar.gz, plus pacman on x64.
5. **Beauty + smoothness are requirements, not polish.** 60fps streaming, zero layout jank, spring motion,
   crisp typography. If it looks average, it is not done.

## 2. Architecture

```
vengeance/
  electron.vite.config.ts   electron-builder.yml   package.json   tsconfig*.json
  src/
    shared/                 # types shared by main+preload+renderer (NO runtime node imports)
      ipc.ts                # the typed IPC contract (channel map) — single source of truth
      engine-types.ts       # common transcript/RPC types, including normalized Prime events
      api/<feature>.ts      # per-feature request/response types
    main/
      index.ts              # app bootstrap, window, single-instance, macOS menu
      window.ts             # BrowserWindow (per-OS titlebar and window controls, Mica, bg color, show-on-ready)
      shell-env.ts          # childBaseEnv(): the environment every child process starts from (§2.4)
      engine/
        locate.ts           # bundled Vengeance Engine, with an explicit development override
        rpc-process.ts      # EngineProcess: spawn the selected CLI with Node, strict LF JSONL framing
        manager.ts          # EngineManager: concurrent sessions, backend dispatch and lifecycle
        sdk-host/           # pi SDK operations in an on-demand child process
        prime/              # Prime resident transport, configuration, sessions and native helper adapters
        bundled.ts          # verified packaged-engine descriptors
      features/settings/    # pi config, narrow SDK imports, provider host and configuration watches
      ipc/<feature>.ts      # IPC handlers per feature, registered from ipc/index.ts
    preload/index.ts        # contextBridge: window.vengeance (typed from shared/ipc.ts)
    renderer/
      index.html  main.tsx  App.tsx
      styles/               # tokens.css (design tokens), globals.css, fonts
      ui/                   # design-system primitives (Radix-based)
      store/                # zustand stores; agents store + event reducer
      lib/                  # helpers (format, keybindings, ipc client, motion presets)
      features/
        shell/              # titlebar, sidebar frame, layout, panes
        chat/               # transcript rendering, messages, markdown, thinking
        tools/              # tool-call renderers (one per tool + generic)
        composer/           # input, attachments, mentions, slash commands, queue
        extension-ui/       # dialogs/toasts/status/widgets requested by pi extensions
        palette/            # Ctrl+K command palette
        sessions/           # session browser, tree/branches, fork/clone
        inspector/          # right panel: stats, context, files touched, timeline, widgets
        settings/           # full settings experience
        onboarding/         # first run: engine detection, provider sign-in, pick folder
  scripts/
    shots.mjs               # Playwright-Electron screenshot harness (see §7)
  .shots/                   # screenshot output (gitignored)
```

### 2.1 Engine (pi) process — RPC

- Each open pi session = one `EngineProcess` = one child `pi --mode rpc` process with `cwd` = workspace folder.
  Multiple sessions can run **in parallel** (a headline feature: several agents working at once, visible in the
  sidebar with live activity indicators).
- Spawn: run the bundled CLI with the app's Electron-as-Node executable and
  `ELECTRON_RUN_AS_NODE=1`: `process.execPath` on Windows and Linux, the pinned Electron helper
  executable on macOS (§2.4).
  Explicit custom locations can use compatible system Node, with Electron's Node as the fallback.
  `windowsHide: true`; on macOS and Linux the child leads its own process group (§2.4). Env:
  `childBaseEnv()` plus the managed variables. Args built from session options: `--session <path>` to resume,
  `--fork <path>`, `--model`, `--thinking`, `--name`, `--approve`/`--no-approve` for project trust, etc.
- Framing: **split stdout only on `\n`, strip trailing `\r`. Do NOT use Node `readline`** (it splits on
  U+2028/2029). Write one JSON object + `\n` per command, honor backpressure.
- Request/response correlated by `id` (`v-<counter>`), with per-request timeouts. Events (no id) are forwarded to
  the renderer. `extension_ui_request` records are forwarded; the renderer answers with
  `extension_ui_response` written back to stdin.
- stderr is captured into a ring buffer (diagnostics view), never parsed as protocol.
- Handle spawn failure, unexpected exit (surface a beautiful recoverable error state with "Restart engine"),
  and orderly shutdown (close stdin; kill after timeout) on window close / session close for pi. Prime
  resident sessions detach on close; see §10.2 for explicit stop and ephemeral-session cleanup.
- IPC event throughput: forward events as they arrive, but the renderer must batch store updates per animation
  frame (`requestAnimationFrame` coalescing) so token streaming never blocks input.

Canonical protocol docs (READ THEM, they are short):
`.engine-staging/bundled/pi/node_modules/@earendil-works/pi-coding-agent/docs/`
`rpc.md`, `rpc-commands.md`, `json.md`, `rpc-extension-ui.md`, `message-types.md`, `session-format.md`,
`sessions.md`, `settings.md`, `models.md`, `providers.md`, `packages.md`, `extensions.md`, `skills.md`,
`prompt-templates.md`, `slash-commands.md`, `compaction.md`, `mcp.md`, `configuration.md`, `keybindings.md`.
Type declarations: `.../pi-coding-agent/dist/**/*.d.ts` (e.g. `dist/modes/rpc/rpc-types.d.ts`).
Example client: `.../pi-coding-agent/examples/rpc-client.ts`, `examples/rpc-extension-ui.ts`, `examples/sdk/*`.

### 2.2 Engine (pi) configuration — SDK / files / CLI subcommands

Operations that are not session-scoped use the selected pi build through main and its SDK/provider
hosts. Prime's independent configuration and helper boundary is defined in §10.

- **SDK (preferred where it exists):** load individual `dist/` modules from the selected pi build
  resolved by `locate.ts`. The on-demand child in `src/main/engine/sdk-host/` handles catalog, packages,
  keybindings and context operations; `src/main/features/settings/pi-modules.ts` declares the narrow
  imports main needs. Do not eagerly import the full SDK entrypoint into main. Use `SettingsManager`, `ModelRuntime`,
  `SessionManager` (list sessions, etc.), `DefaultPackageManager`, `DefaultResourceLoader`, auth storage /
  OAuth login flows from `@earendil-works/pi-ai` (resolved relative to the pi package). Verify every API against
  the `.d.ts` files before use. Use the SDK from the selected engine build, including bundled builds.
- **Files** where pi's own format is the contract: `~/.pi/agent/settings.json`, `<project>/.pi/settings.json`,
  `~/.pi/agent/models.json`, `~/.pi/agent/auth.json` (never send secrets to the renderer — mask them),
  `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`. Writes must be atomic (write temp + rename) and preserve unknown
  keys.
- **CLI subcommands** with streamed output for: `pi install|remove|update|list`, `pi --list-models`,
  `pi auth ...`, `pi mcp ...`, `pi --version`.

### 2.3 IPC contract

`src/shared/ipc.ts` defines:

```ts
export interface InvokeMap { 'engine:create': [args: CreateAgentArgs, agentId: string, result: AgentInfo]; ... }
export interface EventMap  { 'engine:event': { agentId: string; event: EngineEvent }; ... }
```

Preload exposes `window.vengeance.invoke(channel, ...args)`, `window.vengeance.on(channel, cb) => unsubscribe`
fully typed from these maps. Feature lanes add their channels to `src/shared/api/<feature>.ts` and the map is
assembled in `ipc.ts` by intersecting per-feature maps (so lanes never edit the same lines).

Core engine channels (foundation):
`engine:create(opts, agentId) -> AgentInfo`, `engine:command(agentId, RpcCommand) -> RpcResponse`,
`engine:ui-response(agentId, ExtensionUiResponse)`, `engine:dispose(agentId)`, `engine:list() -> AgentInfo[]`,
`engine:restart(agentId, patch?)`, `engine:stderr(agentId) -> string`; events `engine:event`, `engine:exit`,
`engine:status` (starting/ready/crashed/exited/stopping). `engine:describe(engine)` reports the selected
backend; `engine:background-list`/`engine:background-stop` manage native residents. See
`src/shared/api/engine.ts` for the full signatures, bridge, adoption and native Prime command surface.
System channels: `sys:pick-folder`, `sys:pick-files`, `sys:open-external`, `sys:reveal`, `sys:read-file`
(bounded, for previews), `sys:list-files(cwd, query)` (fast: prefer `git ls-files`, then an available
`~/.pi/agent/bin/fd` (`fd.exe` on Windows), then a bounded directory walk), `win:*` (window actions/theme
and focus events), `app:get-state`/`app:set-state` (persisted app prefs in userData: recent workspaces,
open tabs, window bounds, UI prefs).

### 2.4 Platform boundary

Main owns every operating-system difference and gates it on `process.platform`. A POSIX code path is added
beside the Windows one, never in its place.

- **Child environment.** Every child process the app starts (both engines, their CLI subcommands, the
  native helper, git, fd, share tools) builds on `childBaseEnv()` from `src/main/shell-env.ts`.
  - On macOS and Linux an app opened from the Dock, Finder or a desktop launcher gets the session's minimal
    PATH. Main therefore reads the user's login shell environment once at startup (interactive login
    shell, its own process group, 10-second timeout) and merges what it adds into every child's
    environment: PATH, version managers, API keys. Engine and helper spawns await that read; a failed or
    timed-out read logs a warning and keeps the launch environment.
  - Engine and app selection variables (`PI_*`, `PRIME_*`, `VENGEANCE_*`, `ELECTRON_*`) and the probe
    shell's session state (`PWD`, `SHLVL`, `XDG_RUNTIME_DIR` …) always come from the launch environment.
  - On macOS and Linux children never inherit Electron's or the AppImage runtime's changes:
    `ELECTRON_RUN_AS_NODE` is removed (the Engine sets it explicitly when it runs on Electron's Node), and
    inside an AppImage `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD` and every path entry inside its mount (`PATH`,
    `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` …) are dropped, since resident Engine 2 daemons outlive the mount.
    Linux children get the session's `XDG_CURRENT_DESKTOP` back from `ORIGINAL_XDG_CURRENT_DESKTOP`.
  - Windows children inherit the app's environment unchanged. Mock, test (`VENGEANCE_TEST=1`) and
    `VENGEANCE_SKIP_SHELL_ENV=1` runs keep the launch environment on every platform.
- **Window controls.** Main fills `PlatformInfo` (`src/shared/api/app.ts`); the renderer reads it and
  never guesses from `navigator.platform`.
  - `windowControls`: `right` (Windows caption buttons; Electron's on floating Linux desktops), `left`
    (macOS traffic lights) or `none` (tiling Linux: Hyprland, sway, niri, river, i3, bspwm, dwm, qtile,
    awesome, xmonad, wayfire, detected from `XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP` and
    `DESKTOP_SESSION`). `VENGEANCE_WINDOW_CONTROLS=native|none` overrides the Linux detection.
  - `captionButtonsWidth`: the right-side reserve (138 px on Windows, an estimate on floating Linux, 0 on
    macOS and tiling Linux). `titlebarInsetLeft`: the traffic-light inset on macOS, 0 elsewhere.
  - The titlebar prefers the live Window Controls Overlay geometry (`env(titlebar-area-*)`) and falls back
    to these numbers. When the overlay reports itself hidden (macOS full screen), nothing is reserved.
  - `platform.os` also drives shortcut semantics and wording: `mod` is ⌘ on macOS and Ctrl elsewhere,
    macOS shows ⌘⌥⇧ glyphs, and labels name Explorer/Finder/the file manager and Recycle Bin/Trash. This
    spec writes app shortcuts with Ctrl and Alt; on macOS read ⌘ and Option.
- **Processes.** On macOS and Linux every child the app stops as a tree leads its own process group;
  stopping signals the group with SIGTERM, then SIGKILL after a short grace period. Windows keeps its
  PID tree walk. Engine 2 daemons listen on named pipes on Windows and on Unix sockets elsewhere, in a
  folder only the user can open (`$XDG_RUNTIME_DIR/vengeance` on Linux, then the user's temporary
  folder, then `/tmp`), within the platform's socket path limit.
  - On macOS the main Vengeance application remains a normal Dock application. Electron-as-Node
    children use the signed Electron helper with `LSUIElement`, so Engine RPC, SDK/provider hosts,
    CLI subcommands and the login-shell probe never create extra Dock applications or activate an
    app of their own. The helper executable comes from Electron's internal `process.helperExecPath`
    through `src/main/electron-node.ts`; a missing, invalid or unavailable helper fails the operation
    rather than launching the main app executable as a child. Qualification is tied to
    the pinned Electron version and must be repeated on upgrades. Explicit custom system Node
    locations retain their existing behavior.
- **Paths.** On macOS and Linux workspace folders enter the app as their physical path (symlinks
  resolved), the way POSIX `getcwd` reports them and pi records sessions. Canonical paths returned by
  native components map back below the roots they were listed under. Windows paths stay as given.
- **Linux secret store.** On desktops where Chromium would fall back to plain text, safeStorage asks the
  Secret Service (libsecret) instead; an explicit `--password-store` switch wins. Without OS encryption,
  saved workspace launch-environment values stay plain in `app-state.json`, which only the user can read
  on macOS and Linux, and the daemon registry stores no sealed overrides (§10.2).

## 3. Product & UX

### 3.1 Layout

- **Titlebar** (custom, 40px, draggable, Mica-through on Windows 11): app mark + workspace breadcrumb,
  center: command search pill ("Search or run a command… Ctrl K", ⌘K on macOS), and room for the native
  window controls of §2.4: caption buttons at the right via `titleBarOverlay` on Windows and floating Linux
  desktops (colors matched to theme), traffic lights at the left on macOS, none on tiling Linux.
- **Left sidebar** (resizable, collapsible `Ctrl+B`): "New session" (Ctrl+N), workspace switcher, sessions
  grouped by workspace and date (Today / Yesterday / This week / Older) with live state dots (streaming pulse,
  waiting-for-input, error), search filter, pinned sessions, right-click menu (rename, fork, export, reveal
  file, delete).
- **Center:** transcript (max readable width ~760px, centered) with the **floating composer** docked at the
  bottom (glass surface). Session header row: name (inline rename), context-usage ring
  (tokens used / window, hover for breakdown), cost and session actions. Model, reasoning and speed
  controls belong to the composer footer; §9 defines their shared ownership.
- **Right inspector** (toggle `Ctrl+I`): Overview (stats, tokens, cost, context bar, model), Branches (session
  tree), Files (files read/edited/written this session with diff stats), Timeline (tool calls), Extensions
  (status entries + widgets from extensions).
- **Command palette** `Ctrl+K`: fuzzy everything — new session, open session, switch model, thinking level,
  every slash command / extension command / prompt template / skill (`get_commands`), settings sections, toggle
  panels, compact, export, fork…
- **Settings:** full-window sheet (sliding in), left nav of sections, search across all settings.
- **Onboarding** (first run / missing engine / no credentials): beautiful 3-step flow: Engine detected ✓ →
  Connect a provider (OAuth sign-in or API key) → Choose a project folder.
- **Empty state** of a new session: big calm hero with the Vengeance mark, workspace name, a few suggested
  prompts derived from the project (e.g. "Explain this codebase", "Find bugs in…"), recent sessions.

### 3.2 Transcript

- User messages: right-aligned soft bubble (or full-width subtle card — designer's call, keep it elegant),
  attachments as thumbnails.
- Assistant: no bubble, beautiful typography, GitHub-flavored markdown, Shiki highlighting (lazy-loaded
  languages, theme matched), copy buttons on code, tables, math optional. Streaming text animates in smoothly
  (no flicker, no re-highlighting the whole doc each token — memoize completed blocks, only the tail block
  re-renders).
- Thinking blocks: collapsed "Thought for 12s" chip with shimmer while thinking; expandable, dimmed italic.
- **Tool calls are first-class, gorgeous cards** (see §3.3). Consecutive tool calls group into a compact
  "activity stack" that can expand.
- Message actions on hover: copy, fork from here, edit & resend (fork at previous entry), retry.
- Compaction summaries, branch summaries, custom extension messages, bash executions (`!cmd`), errors,
  retries ("Retrying in 3s… attempt 2/5" with countdown), aborted states — all have designed renderers.
- Auto-scroll sticks to bottom while streaming unless the user scrolls up; "Jump to latest" pill appears.
- Long sessions stay fast (virtualize or windowed rendering; memoized messages).

### 3.3 Tool cards

Card = icon + verb + primary arg (e.g. `Read  src/app.ts  L1–120`), live status (spinner → check/✕), duration,
collapsible body. Per tool:

- `bash`: command with shell prompt glyph, streaming output in a mono console with ANSI color support, exit
  code badge, truncated with "show all".
- `read`: file path chip with language icon, line range, syntax-highlighted preview (collapsed by default).
- `edit`: real **diff view** (unified, with +/- gutters, word-level highlight), +N −M stats.
- `write`: new-file badge, highlighted content preview, line count.
- `grep`/`find`/`ls`: compact result lists with match highlighting.
- Unknown/extension tools (subagent, web search, todo, `ask_user`, MCP tools, lens…): smart generic renderer —
  pretty args (key/value, not raw JSON), result text/markdown/images, and **specialized renderers** for common
  ones installed here (subagent runs, todo lists, web search results, ask-user-question) when their result
  shapes are recognizable.
- Errors: red-tinted card with message, expandable details.

### 3.4 Composer

- Auto-growing textarea (1→12 lines), placeholder rotates helpful hints. Enter = send, Shift+Enter = newline.
- While agent runs: Enter = **steer**, Alt+Enter = **follow-up** (show both via a split send button), queued
  messages displayed as chips above composer (removable via clear_queue semantics), Esc (twice) / stop button =
  abort.
- `/` opens slash-command menu (from `get_commands`: extension commands, prompt templates, skills, built-ins
  that RPC supports), `@` opens file mention picker (fuzzy, from `sys:list-files`), `!` prefix runs bash via RPC
  `bash` command and shows it in transcript.
- Attachments: drag-drop / paste images (sent as image content), files (inserted as @-references or content).
- Footer row inside composer: model pill, thinking level, attachment button, context ring mini, keyboard hint.
- **MCP chip** in the row above the composer when the conversation has MCP servers or MCP configuration
  errors: connected out of total (`not started` while Engine 2 has not opened them, `config error` for
  errors alone), how many need attention, and the worst state as its dot. It opens a panel listing every
  server separately with its live state (connected with its tool count, connecting, needs sign-in, failed
  with its error, off, blocked until the project is trusted), _Reconnect_ for each server the
  conversation runs, sign-in where the server needs it and, on the Engine, an on/off switch. The switch
  never changes every folder without saying so: in a trusted folder it turns a server of the global
  mcp.json on or off for this folder alone, as a project override (like the Engine's own _Disable in
  this project_); otherwise it saves where the Engine says, and its tooltip and accessible name say
  where (this folder, every folder, or this conversation only). When switches save to the global
  mcp.json, a line in the panel says they apply to every folder. A server that is connecting again
  shows no error from its earlier attempt. Engine 2 turns servers on and off in Settings. The panel
  links to MCP settings.

### 3.5 Extension UI (rpc-extension-ui.md)

`select` → elegant list dialog; `confirm` → dialog; `input` → prompt dialog; `editor` → modal code editor;
`notify` → toast (info/warning/error); `setStatus` → status entries in inspector + subtle footer chips,
each of which opens the full status text it abbreviates; `setWidget` → widget cards in inspector (render lines as styled text, ANSI-aware); `setTitle` → session title;
`set_editor_text` → replaces composer text. Timeouts honored.

### 3.6 Settings (every pi setting is editable)

Sections: **General** (theme/accent/font size/density — app prefs), **Models** (default provider/model,
thinking level, per-model thinking levels, enabled models for cycling, `--models` scopes), **Providers &
Accounts** (sign in with OAuth providers, add/remove API keys — masked, test connection, readiness via
`pi auth`), **Custom models** (models.json providers/models editor), **Agent behavior** (steering/follow-up
mode, auto-retry, compaction + branch summary settings and per-model overrides, tools defaults
(`defaultTools`), shell settings, network/retry), **Extensions** (community gallery from the public npm index of
`pi-package` packages: search, topics, details with what a package adds, one-click install for every project or
this project, add your own extension file or package folder; read-only network, respects offline mode),
**Packages** (installed list, install from npm/git with live log, update, remove, global vs project scope),
**Resources** (extensions/skills/prompt templates/themes —
enable/disable like `pi config`, show source package), **MCP** (servers list, sign-in, and each server's live state across the folder's open sessions
(the worst state, and how many sessions are in each), with _Reconnect_ in those that run it), **Sessions &
Context** (context files, session dir, trust), **Keyboard shortcuts** (app-level), **Engine** (detected
version/path, development override, app-owned update policy, diagnostics/stderr log, open config folder), **Raw JSON** (global and
project settings.json with validation). Global vs Project scope switch where pi supports project settings.
Read the selected pi package's `docs/settings.md` and implement _every_ key it lists.
When a provider refuses to renew an Engine sign-in (its token endpoint rejects the refresh token: see UPSTREAM.md
for the codes), the Engine marks the credential in auth.json with `refreshRejectedAt` and stops using it until a
new sign-in replaces it. Providers shows it as _Sign-in expired_ with _Sign in again_, and so do a failed reply
and the error toast of a command that hit it (such as sending, compacting, summarizing a branch or switching
models), where _Sign in again_ opens Providers. Onboarding and model lists stop counting it as connected, without
a restart offer: open Engine conversations that read that auth.json leave its models out of their model list and
model cycle, and those that use Vengeance's agent dir and load the bridge also re-read the sign-in, so extensions
(such as session auto-title packages) stop picking the provider. A conversation with the bridge that starts, or
switches to the Engine, while its auth.json holds the mark re-reads it once ready. The new sign-in that clears the
mark offers a restart like any other sign-in.
A restart offer ("Restart to apply") names what changed (packages, sign-ins, or the settings edited outside
Vengeance). Writes an engine makes while applying a live change (runtime toggles it saves itself, such as the MCP
panel's switches, models chosen in a session) never offer a restart, and a project's config changes only concern
that folder's sessions.

System prompt settings show the selected engine's native foundation as a read-only view. A foundation
preview excludes user files and runtime additions. The Engine 2 foundation comes from the bundled native
helper, which is identified separately from a custom engine location. An open conversation's assembled
prompt is shown with that conversation (below), not in Settings.

Users can edit global or project `SYSTEM.md`, `APPEND_SYSTEM.md` and context instructions, customize
the built-in foundation, and restore inherited defaults. The editor explains native precedence and
launch overrides, protects unsaved drafts, refuses conflicting external edits and bounds file sizes.
Saving an instruction file never restarts open work, regardless of the automatic restart preference.
Applying it to an open conversation is explicit: that conversation's instructions dialog restarts it
through the guarded restart path. On both engines explicit launch-time append text replaces
`APPEND_SYSTEM.md` for that launch, and a launch-time replacement replaces `SYSTEM.md`.

**Conversation instructions** belong to one conversation and are edited there, never in Settings. A
session-header control (highlighted while the conversation has instructions), `/instructions [text]` on
both engines and a palette action open one dialog. It stays with its conversation, draft and errors
while another session comes to the front or the engine stops, and closes with the conversation.
Engine 2's `/system-prompt` still opens its native context panel.

- **Modes.** _Add to engine prompt_ (the default) adds the text to the engine's prompt; a saved
  `APPEND_SYSTEM.md`, or explicit launch-time append text in its place, stays and comes first.
  _Replace foundation_ replaces the foundation like `SYSTEM.md` and wins over `SYSTEM.md` and
  launch-time replacements: the Engine drops its tool list, tool rules and docs sections, Engine 2 its
  core, usage, opinionated and per-model layers. `APPEND_SYSTEM.md` still applies. In both modes each
  engine keeps its own runtime assembly: project context, skills, MCP, the working folder and, for
  Engine 2, the date, environment, capability and role sections.
- **Composition.** Main composes the instructions with each engine's native explicit sources at every
  spawn, from fresh discovery, never inside `launch` or workspace defaults. The Engine receives
  `--append-system-prompt` (the effective `APPEND_SYSTEM.md` or the launch append entries, then the
  instructions) or `--system-prompt`; Engine 2 receives the same sources in its create configuration.
  Both engines read explicit sources again later (the Engine on a reload, Engine 2 when a worker is
  recreated) and take a missing path as literal text, so a discovered `APPEND_SYSTEM.md` goes in as a
  copy of its text taken at that spawn: in these conversations an edit or removal of the file applies
  from the next restart, not on a reload. For the Engine the instructions and that copy travel as
  content-addressed files in userData, never deleted while a conversation references them or a process
  of this run uses them; Engine 2 gets both as literal text. Its restart patch carries changes and
  removals, and always sends the prompt sources of a conversation with instructions to a resident the
  restarting process did not create.
- **Persistence.** Main owns the store, keyed by engine and session file, in an atomic JSON file in
  userData. It writes only once a restart applied them (the restarted process started without crashing,
  or Engine 2's native restart applied them to its running resident, even when the re-attach then fails;
  without a running resident only the started process counts), or when Switch engine or a fork carried
  instructions to a new session file, so a refused or rolled-back restart changes nothing. Every
  resume of the session file (open, restore, background resume, crash restart) gets them from main.
  Fork, branch, clone and import (continuing a session from a moved folder or another session folder)
  copy them to the new file, and Switch engine carries them. Moving the session to the trash deletes
  them, and so does closing an Engine chat before its session file was written. Temporary sessions keep
  them only for the open agent. A store file that
  cannot be read is read again on the next use and is never written or cleaned up over meanwhile (a
  change is refused); one that cannot be parsed is kept aside as `conversation-prompts.json.corrupt-<time>`
  before the first write.
- **Process boundaries.** Instructions are launch flags of the process started with them. Main refuses an
  in-place session switch from or to a conversation that has instructions; the app opens the target in
  its own agent instead. A process that moved to another session file without the app (an extension
  command, a native session replacement) restarts with that file's own saved instructions, and so does
  an Engine temporary chat that opened a saved conversation.
- **Applying.** _Save and restart_, _Remove_ and _Restart_ (for prompt files saved since the
  conversation started) use the guarded restart path. They are disabled with a reason while the engine
  starts, works, compacts or waits on an extension dialog, and for temporary chats that cannot restart
  (Engine 2 temporary chats; Engine temporary chats with messages). A refusal shows in the dialog and
  keeps the draft. The Engine applies a change from its next turn as a mid-conversation system update;
  Engine 2 restarts with every idle session running in it, and busy work blocks it. Text is bounded by
  `CONVERSATION_PROMPT_MAX_CHARS` and an unsaved draft is protected. `/instructions <text>` on a
  conversation with instructions starts the draft as the saved text followed by the new text.
- **Assembled prompt.** _View assembled prompt_ reads the open conversation's prompt from its engine,
  identifies the session and says it is a snapshot (the Engine's: as of its latest turn), since native
  hooks can change later requests. Between turns the Engine reports the full prompt of the latest turn
  in its session while what it was built from holds (the base prompt, the active tools and the MCP
  servers' status, whoever changed them); before a turn ran since the Engine last opened the
  conversation (a restart opens it again), or after one of them changed, it reports the base prompt
  without turn-start sections such as MCP servers, labeled as partial. The button is disabled while the engine is not running or cannot
  report its prompt, and on the Engine while a turn runs; the dialog then says why, also when it already
  explains that the conversation cannot restart.

### 3.7 Updates — qualified engines with app releases

- Vengeance bundles its own source builds of both engines. Engine upgrades ship together with app
  releases, after upstream compatibility and local patches have been qualified. The renderer must
  degrade gracefully on unknown event/message/tool types (generic renderers, never crash).
- Background update checks (on launch + every 6h, configurable; respects `PI_OFFLINE`/offline setting):
  installed packages (`pi list` + npm/git latest) and the Vengeance app. Surface an "Updates available"
  pill in the titlebar → Updates sheet showing the included engine build and package/app updates.
- Auto-update setting: Off / Notify (default) / Automatic. Automatic updates packages when no agent
  is streaming and downloads app updates where the install can replace itself. Native self-update,
  engine reinstall, upstream channel switching and per-engine rollback are unavailable;
  updating/reinstalling Vengeance owns engine files.
- After package or resource changes, refresh the affected backend's capabilities and settings.
  Engine can reload through its bridge. Engine 2 applies startup-bound changes through an explicit,
  guarded saved-session restart; selecting or installing a new build does not replace live residents.
- Vengeance app self-update: `electron-updater` with the generic provider, so the shell can update too.
  Release builds bake `https://github.com/LuciferMornens/vengeance/releases/latest/download` with update
  channel `latest`, so prerelease builds also check the newest stable release. A feed URL set in
  Settings → General wins over the baked one. Local `npm run dist` builds carry no feed unless
  `VENGEANCE_UPDATE_FEED` is set. Without a feed, and in unpackaged runs, app updates are disabled.
  Installation follows the package type:
  - **Windows NSIS and Linux AppImage** replace themselves. Notify announces the version and offers the
    download, Automatic downloads it, and a downloaded update installs on Restart or when the app quits.
  - **macOS** (ad-hoc signed; Squirrel.Mac needs a Developer ID signature) **and Linux deb, rpm, pacman
    and tar.gz** are notify-only: the Updates sheet names the version (and the package type to get, when
    one is recorded) and its Download action opens that version's GitHub release page. The app never
    downloads or installs these updates; the system package manager or the user does.

## 4. Visual design language — "Obsidian & Ember"

- Mood: dark, quiet, expensive. Think Linear × Raycast × Arc, with a dangerous edge. Dark theme is the hero;
  a refined light theme ("Bone") also ships.
- Colors (dark): background `#0B0B0E` (under Windows 11 Mica, window bg slightly translucent; solid on
  macOS and Linux), surfaces layered `#111116`, `#16161D`, `#1C1C24`; hairlines
  `rgba(255,255,255,0.06–0.10)`; text `#EDEDF2` / secondary `#A0A0AE` / tertiary `#6B6B78`. **Ember
  accent**: `#FF4D3D` → `#FF8A3D` gradient, used sparingly (send button, active streaming glow, focus ring,
  selection, the logo). Semantic: success `#3DDC97`, warning `#F5B84B`, danger `#FF5C6C`, info `#6CA8FF`.
  All as CSS variables in `tokens.css`; accent is user-swappable (Ember, Violet, Cyan, Lime, Rose, Mono).
- Typography: **Geist** (UI) + **Geist Mono** (code), bundled locally via `@fontsource-variable/*` or the
  `geist` package — never load from the network. Base 13.5px UI, 15px transcript body, generous line-height
  (1.65 for prose), tabular numbers for stats, tight letter-spacing on headings.
- Shape: radius 10px (cards), 14px (composer/dialogs), 6px (chips). Soft layered shadows + 1px inner
  highlight on elevated glass surfaces. Subtle noise texture on the window background (very low opacity).
- Motion: spring presets (`motion` / framer-motion). Hover 120ms, panel/sheet 220–320ms springs, list items
  stagger in, tool cards expand with layout animation, streaming caret glow, shimmer on "thinking". Respect
  `prefers-reduced-motion`. Never animate layout of the streaming text itself in a way that causes jank.
- Icons: `lucide-react`, 16px, 1.75 stroke.
- Scrollbars: thin overlay-style custom scrollbars. No default browser focus outlines — custom accent focus
  ring on keyboard focus only (`:focus-visible`).
- The Vengeance mark: a sharp, minimal geometric "V" glyph (SVG) with the ember gradient. Also used for the
  window/app icon: `npm run icons` renders the Windows `.ico`, the 1024px PNG electron-builder turns into
  the macOS `.icns`, the Linux hicolor sizes and the window icon from `build/icon.svg` (outputs committed).

## 5. Tech stack

Electron (qualified version pinned in `package.json`) + electron-vite + Vite + React 19 + TypeScript (strict) + Tailwind CSS v4 (with CSS
variables from tokens.css) + Radix UI primitives + `motion` (framer-motion) + zustand + `cmdk` +
`react-markdown` + `remark-gfm` + `shiki` + `diff` + the local ANSI SGR parser + `lucide-react` +
`@tanstack/react-virtual` + `@fontsource-variable/geist` & `geist-mono` + electron-builder.
Dev: Playwright (`playwright` package, `_electron`) for screenshots/E2E. ESLint optional; `tsc --noEmit` is the
gate.

## 6. Mock engine (for deterministic UI work)

`VENGEANCE_MOCK=1` makes the main process use a `MockEngineProcess` that speaks the same event protocol and
replays realistic scripted runs (thinking → text streaming → read/edit/bash/write/grep tool calls with results →
an extension `select` request → final answer, plus get_state/get_commands/get_available_models/
get_session_stats/get_tree responses with plausible data). This exists so UI can be built and screenshotted
without spending tokens. **The real engine is the default and must always work.**

## 7. Validation gates (every lane)

1. `npm run typecheck` passes (strict, zero errors).
2. `npm run build` passes.
3. `npm run shots` (Playwright `_electron.launch` against the built app, `VENGEANCE_MOCK=1`) produces PNGs in
   `.shots/` for your feature's key states. **Open and look at your screenshots** (read the PNG files) and
   iterate until they are genuinely beautiful. Add your scenarios to `scripts/shots.mjs` (each lane owns its
   own scenario file under `scripts/shots/<feature>.mjs`, auto-discovered).
   Finish renderer builds before starting UI QA; run GUI suites serially so build output and focus
   remain stable. Failure screenshots and renderer errors are diagnostics, not passing evidence.
4. Real-engine smoke (where relevant): launch with the real engine and verify the flow works
   (`npm run e2e:real` — sends one short prompt like "Reply with just: ok" in a temp folder; keep token usage
   tiny).

CI (`.github/workflows/ci.yml`) runs gates 1–3 on every pull request and on `main`: typecheck, an app
build and workflow lint on Linux, then `npm run build`, `npm run checks` and `npm run shots` on Windows x64,
macOS arm64 and Linux x64 against engines built the way releases build them. Linux shots run under Xvfb
(a 2560x1440 virtual screen). CI uploads each platform's PNGs; a green run is not a visual review, so
inspect the images for the platforms a change affects. Screenshots capture the page only, not Mica, the
macOS traffic lights or Electron's Linux caption buttons. Gate 4 is not part of CI.

## 8. Working rules for agents

- Read this spec + `AGENTS.md` first. Stay inside your lane's owned paths; touching shared files
  (`src/shared/ipc.ts`, `src/renderer/store/agents.ts`, `App.tsx`, `package.json`) only additively and
  minimally, and say so in your report.
- Don't add dependencies unless necessary; if you do, `npm install` it and list it in your report.
- Commit your work on your branch with clear messages when done (`git add -A && git commit`).
- Report: what you built, files changed, validation results, screenshot paths, known gaps.

## 9. Shared control and layout decisions (supersede earlier sections where they conflict)

1. **Single owner for model/thinking controls: the composer footer.** The footer model pill opens the
   one shared `ModelPicker` popover (features/chat/ModelPicker, exported with `ModelRow`); the thinking pill
   opens the thinking control. The **session header** no longer has model/thinking pickers: it shows the
   session title (inline rename), a passive context ring + cost (hover breakdown), and a right-aligned
   toolbar (conversation instructions, fork, export, inspector toggle). The palette Models page reuses
   `ModelRow`.
2. **Titlebar = workspace crumb only** (+ search pill, neutral background-activity pill, updates pill).
   The session title lives in the session header. Session titles never repeat the workspace name
   (strip a leading "<workspace> · " from extension-set titles).
3. **Ember ≠ danger.** Soft ember surfaces/text derive from `--accent-2` (orange
   family); solid `--accent` only for the primary CTA fill, live dot, caret; `--danger` shifts to rose and is
   the only true red. Focus rings neutral-bright, not red. Status chips/badges neutral unless semantic.
4. **Toasts bottom-right**, inspector/composer-aware offsets, max 3 visible, below modals.
5. **Composer height is a CSS variable** `--composer-h` (set by Composer via ResizeObserver on the session
   pane); transcript bottom padding and the jump pill use it.
6. **Never say "pi" in UI copy.** Use "Engine".
7. **Project trust is explicit:** opening a folder with project resources and an undecided trust state
   shows the Trust dialog before the engine starts.
8. **Launch options** (`src/shared/api/launch.ts`, `CreateAgentArgs.launch`) carry per-workspace defaults
   and per-session overrides; extension flags are discovered from `pi --help` and rendered as controls.
9. **Bridge extension**: Vengeance ships `resources/bridge/vengeance-bridge.ts`, loaded with
   `-e`, exposing hidden commands for in-place tree navigation, reload, tool toggles and labels; results
   flow back through `setStatus('__vengeance:<reqId>', json)` and are hidden from the UI. If it fails to
   load, the app falls back gracefully.
10. **Live MCP status** (`src/shared/api/mcp.ts`) has one shape for both engines. In the Engine the
    bridge publishes it on the hidden status `__vengeance:mcp`, from the built-in MCP extension's host
    channel on `pi.events` (`mcp:state` and `mcp:request`, Vengeance patch 0009) or, when only
    pi-mcp-adapter runs, from the status snapshot it publishes; adapter actions go through its own
    `/mcp` commands. Each built-in server says where on/off saves (`saves`: the global or project
    mcp.json, or the session for servers an extension registers) and, for a global server without a
    project override in a trusted folder, the project mcp.json that `enable-project` and
    `disable-project` save an override to; the panel's switch uses those actions whenever they are
    offered, and is hidden for a server whose save target the Engine does not report. Engine 2
    answers on request from its configured connections and the session kernel's `get_mcp_status` and
    `reconnect_mcp_server` (Vengeance patch 0024), which never start a kernel. The active conversation
    asks 4 s after start (at once when it already has a status), after each turn, then every 30 s, or
    every 5 s while the panel is open or, twice in a row, while a server is connecting; never while the
    window is hidden, and at once when it is shown again. A conversation's MCP requests run one at a
    time (a listing holds each server while it opens it), and a reply older than the one shown, or
    from before a restart, is dropped. The kernel gives each server 10 s in a read and 20 s in a
    Reconnect, and cancels an open that takes longer, so its bare timeout says only that the server
    did not answer: the first since the server last answered, the kernel started or a Reconnect reads
    as connecting (it may still be opening, or wait behind a tool call), and the next reads as failed
    with that reason. Without a running kernel the states come from the configuration and the chip
    reads `not started`; a listing that fails keeps the last status. Reconnect reaches every
    connection of a row (each account of a catalog service), is offered only for servers the running
    kernel lists, and stays available while a read has one connecting: Engine 2's reconnect settles
    before it answers.

## 10. Dual-engine decisions (supersede earlier pi-only assumptions)

### 10.1 Native boundaries and configuration

- `EngineId` (`pi` or `prime`) belongs to every live agent, saved-session summary, persisted open tab and
  workspace default. A workspace's selector chooses the backend for new sessions. Resume, restore, fork,
  clone, import and resident attachment carry the session's provenance; changing a workspace default does
  not convert an existing session. Restart must reject changing an agent's backend.
- An explicit **Switch engine** action can hand off an idle saved conversation to the other backend.
  The current tab and draft stay in place. Each backend writes its own native session; the transfer
  carries the selected branch's full message history, tool results, attachments and compaction
  boundaries. Unsupported historical records remain clearly labeled history, never live commands.
  The destination uses its own model, configuration, credentials and project trust. It must become
  ready before the source stops; a failed preparation leaves the source available. The source file
  remains a recovery copy. Native goals, schedules and child workers do not transfer. Nonempty
  ephemeral sessions cannot switch until native in-memory history import is supported.
- The composer engine menu distinguishes switching this conversation from starting a new one with
  either engine. Neither action changes the workspace default; its selector is labeled separately.
- Choosing an engine in Settings also saves the active workspace's default for new sessions. Without
  an active workspace, it saves the app default for newly opened folders. Other workspace defaults stay
  separate. Ordinary Settings and palette navigation use the saved workspace default; a session-specific
  configuration action targets that session's engine and shows which engine new sessions will use.
  Switching the settings engine or workspace resets its forms and cancels pending sign-in prompts.
- pi uses its bundled CLI/SDK, LF-delimited RPC, bridge extension and native config.
  Prime uses its bundled executable and native resident daemon/session API. Normalized transcript events
  let both render in the shared chat UI; native Prime commands and events remain available to its controls.
  Prime must not load pi's SDK, bridge, providers or extension runtime to perform its operations.
- Backend capabilities govern controls. Prime exposes native settings, providers/models, packages,
  resources, MCP, instructions, keybindings, session operations and resident agents. It does not use pi's
  extension dialogs or per-project trust decisions; those controls must not be offered for Prime.
- Settings requests explicitly identify their backend. pi's global directory is resolved through
  `PI_CODING_AGENT_DIR` or its native default. Prime's is `PRIME_AGENT_CODING_AGENT_DIR` or
  `~/.prime/agent`; Prime project settings live in `.prime/agent/settings.json`. Model, auth, launch-default,
  environment and trust state remain backend-specific. Never copy credentials or silently fall back to
  the other backend's configuration.
- Preserve unknown native JSON keys and mask secrets before renderer delivery. Configuration writes use
  atomic transactions and the native account-store lock where applicable. Resource discovery and package
  management use that backend's public APIs and CLI commands rather than assuming pi package semantics.
  Native worker/launch settings that are captured at startup require an explicit session restart; live
  settings continue to use the backend's runtime APIs.

### 10.2 Resident lifecycle and saved sessions

- pi owns one child process per open agent. Prime attaches to native resident agents through its daemon,
  including agents created outside the current window. Closing a saved Prime tab or quitting Vengeance
  detaches its client; it does not end that resident agent. Background-agent controls list, resume and
  explicitly stop residents. The Stop action is the deliberate native operation that ends a resident.
  The sidebar calls these “Background sessions” and includes idle residents; idle does not mean there is
  no saved goal, scheduled work or child activity. Saved tabs say “Close tab” and explain that the session
  stays running. Explicit “Stop session” controls name the stop and saved-history consequence.
- Ephemeral Prime `noSession` agents are aborted and completed when their app handle closes. Temporary
  QA daemons must be shut down by the harness that created them; development must not terminate another
  app's or CLI's daemon. Transport reconnects reattach to the native identity and reject stale replies.
- Reconnecting restores committed history and native busy/Stop state immediately. Prime 0.10's attach
  snapshot does not include in-progress streamed message content and its public protocol does not replay
  old events. Text from an unfinished turn depends on a subsequent full native event or the turn settling;
  do not promise immediate replay of pre-disconnect partial text.
- Vengeance daemon endpoints are keyed by the native executable, account directory and launch environment
  (named pipes on Windows, private Unix sockets on macOS and Linux; §2.4). Registry metadata in
  `<Prime agent directory>/vengeance-daemons.json` lets the app find residents across
  restarts and engine updates. Background enumeration only probes known endpoints and must not launch a
  daemon just to list them. Each attached session reports its live Engine version separately from the
  selected Engine version. A mismatch shows a persistent session notice with an explicit restart action;
  installing or selecting another Engine never restarts resident work automatically.
  Incomplete native selected-model descriptors resolve capabilities by exact provider and model ID from
  that resident's own catalog. A failed lookup is unknown support, not a text-only declaration.
  The registry stores runtime endpoint/version and a hash of explicit launch overrides; an optional
  Electron `safeStorage` blob seals those overrides. It never stores inherited process environment or
  plaintext secrets. Decrypted overrides remain in main; an old or unreadable nonempty environment must
  be supplied correctly before restarting its resident.
- Explicit Engine 2 restart uses native `prepare_update_restart`, `commit_update_restart` and roster
  restoration on the same endpoint. All resident workers must be idle; a busy sibling rejects the
  restart without interrupting it. The pinned helper applies the selected executable, saved settings and
  explicitly changed launch fields. Native recovery snapshots carry queued messages, goals, kernel,
  child-agent and schedule state; successful restoration verifies a new worker process.
  After native preparation reaches `Prepared`, its mutation fence protects capture of every resident's
  live provider, model and thinking level through `get_connection_state`. The helper validates complete,
  unique roster/descriptor coverage and every native create envelope before commit. Each resident keeps
  its captured selection in both descriptor replay and roster fallback; explicit target launch changes
  apply last. A sibling's defaults or original launch selection never replace that live selection.
  Active product side questions and side questions observed through attached clients also block restart.
  The native API cannot query a previously unseen side question owned by an external client; the guard
  must not claim visibility into that work. The normal app-owned daemon disconnect aborts its client-owned
  questions.
  User temporary sessions cannot restart in place; changing their startup settings requires a new
  session. Refusal keeps the temporary resident and its messages intact. Other user temporary sessions
  sharing the daemon must close before a saved resident restarts. Internal configuration-service workers
  drain within a bounded period before a native restart.
- Both engines reject restart while startup or a session operation is in flight. Engine 2's read-only
  MCP status reads are not session operations: restarts and engine switches do not wait for them and
  close their connection, which fails the read; MCP actions are. Restart preparation
  excludes new commands and checks native streaming and compaction state before stopping anything.
  Engine refuses restart with queued messages or nonempty temporary history that cannot be restored;
  it carries the live model and reasoning selection unless the restart explicitly changes them.
- Launch-environment changes are rejected while other residents share the daemon. Unknown background
  launch environments also fail closed. Startup failures attempt the prior executable/environment/config
  rollback only after all relevant native processes are confirmed stopped. An ambiguous running
  replacement keeps the recovery snapshot and a scoped quarantine, and reports a recoverable error
  instead of risking a second worker.
- Native restart compatibility handling captures prepared same-daemon descriptors, recovery journals and
  the roster before commit. The installed native commit path can also run terminal cleanup and remove
  those recovery files. Restore their captured native contents only after verifying that the relevant
  workers stopped, then launch the selected successor and restore its roster through the native API.
  If the successor fails, restore the raw backups and reapply every checkpointed live selection with no
  target launch patch before launching the prior executable. Keep the raw recovery backups intact.
- Prime saved-session listing and workspace discovery read native JSONL metadata without starting a
  worker, model request or Python environment. Discovery is cached and coalesced. Mutations invalidate
  the appropriate listing, while background residents remain reachable by their native identity.
- Rename, export, import, tree navigation, labels and branching operate on their backend's native session
  data. The native helper performs full saved-session forks and selected-entry branches without taking
  over a resident worker or rewriting the source. Session files must never be interpreted by the other
  backend's SDK merely because both formats use JSONL.

### 10.3 Native helper

- Prime subscription sign-in uses upstream `pa_ai::oauth` implementations for Anthropic, GitHub Copilot,
  OpenAI Codex and xAI. Prime Inference, Prime Agent Traces and MCP sign-in use upstream `pa_core` APIs.
  Vengeance supplies graphical notices/prompts and stores the returned native credential only in the
  Prime account store. Other provider keys use that store directly; MCP static tokens use the native
  daemon command. Authentication must not borrow pi provider implementations or account files.
- `resources/prime-auth` contains the small native helper's source, checked-in Cargo lockfile and notices.
  Its upstream revision is pinned to `763094e1b6a7c17450ee8399b06cda1853847ca5`; the main process validates
  protocol version 1 and this revision before beginning a sign-in. Updating the installed Prime engine
  does not implicitly update the helper's linked native implementation. A helper upgrade requires an
  explicit source/lockfile/protocol review and a Vengeance rebuild.
- The helper also calls native saved-session, resource and trace APIs. Resource resolution includes
  disabled resources and configured package metadata without installing missing packages. Resource
  toggles use the native configuration writer. Trace controls expose status, enabling/disabling,
  preview and requested uploads; upload actions send native session data only when the user invokes them.
  Its `--restart-config` mode applies typed native launch configuration to a prepared recovery snapshot;
  metadata advertises this as `restartConfig`. Its precommit capture mode is advertised as
  `restartCapture`, and complete live-selection validation and restoration as `restartSelections`.
  All three capabilities are required before native restart preparation.
- Private child-process JSON Lines carry credentials to main only. Renderer events contain prompts,
  notices and completion status. Bound frames, expire idle flows, cancel pending prompts and terminate
  the helper on cancellation or app shutdown. Once atomic credential saving begins, finish that write.
- `npm run build:auth` builds or reuses the fingerprinted helper; `predev` and `prebuild` invoke it.
  It builds for the host's Rust target from `engines.lock.json` only, as `vengeance-prime-auth.exe` on
  Windows and `vengeance-prime-auth` on macOS and Linux, with a `build.json` receipt beside it in
  `resources/prime-auth/bin`. Reuse needs no checkout or toolchain: the receipt's source, engine, platform
  and target fingerprint and executable hash must match, and off Windows the file must still be
  executable. The helper passes Engine 2's runtime dependency checks (§10.4); on macOS it targets 13.0 and
  is ad-hoc signed before its hash is recorded. End users need no Rust toolchain. Packaging stages the
  host's executable and third-party notices in `<resources>/prime-auth`, outside ASAR. pi's bridge and
  external-node provider host also remain accessible as real files. See `resources/prime-auth/README.md`
  for native APIs, protocol and update procedure.

### 10.4 Bundled engines and release validation

- `engines.lock.json` (schema version 2) pins latest qualified stable tags, exact commits, Vengeance build
  versions and ordered source patches, and maps each supported platform (`win32-x64`, `darwin-arm64`,
  `darwin-x64`, `linux-x64`, `linux-arm64`) to its Rust target. Every platform builds natively on its own
  host; nothing is cross-compiled. `npm run build:engines` builds both engines for the host only, refuses
  a host the lock does not list, and stages complete runtimes under `.engine-staging/bundled`. The staged
  manifest records the build platform and Engine 2's resolved target and entry (`prime/prime-agent`, plus
  `.exe` on Windows). Packages carry the runtimes outside ASAR in `<resources>/engines`
  (`Vengeance.app/Contents/Resources/engines` on macOS). Release packaging refuses stale inputs,
  altered/incomplete payloads and payloads staged for another platform or architecture. Distribution
  versions include `+vengeance.N`. pi's SDK `VERSION` and native package versions identify its upstream
  API release; its CLI, distribution metadata and Vengeance engine descriptor identify the customized
  build.
- Shipped native executables need nothing beyond the operating system. Windows PE imports exclude GNU
  compiler runtime DLLs. Linux ELF files link only the C runtime and use no symbol newer than GLIBC 2.35:
  release builds run in an Ubuntu 22.04 container, and the release workflow checks the packaged app again.
  `VENGEANCE_GLIBC_BASELINE=host` accepts a newer glibc for a local build used only on that machine; such
  builds never ship. macOS Mach-O files link only system libraries and frameworks, support macOS 13.0
  (the app's minimum) and carry a valid ad-hoc signature. The engine builds ad-hoc sign Engine 2, the
  helper and pi's prebuilt darwin addons before hashing them; packaging leaves those files untouched and
  the app's own ad-hoc signature seals them. macOS builds have no Developer ID signature or notarization.
- Payload hashes are per platform. Checkouts use LF line endings on every host, and inventories sort names
  in code-unit order and record executable bits on macOS and Linux, so neither payload bytes nor hashes
  depend on the builder's Git configuration or locale, and a lost executable bit fails verification. pi
  installs its runtime without `node_modules/.bin` links; the CLI only runs through Electron's Node.
- Both engines default to the bundled builds. Explicit custom locations remain available for development
  and testing; there is no implicit PATH or global-install fallback. Missing bundled files require an
  app repair. The Engine uses Electron's Node runtime, so users need no separate Node installation.
- Engine 2 runs from a complete, versioned copy under `userData/engines/bundled-prime/<payload hash>`.
  Resident daemons can keep their files across app upgrades without locking the install directory.
  Old runtime caches remain available for residents and saved recovery references; do not remove an
  in-use cache. Native account/session stores remain separate from executable distribution.
- Update state, logs and settings carry backend identity. An operation must never update the other
  backend's packages or restart its agents. Offline mode suppresses network checks. Engine-owned
  package updates use the corresponding native CLI; self-updates fail in both app IPC and native builds.
- All original validation gates remain required. Dual-engine QA additionally exercises the public IPC
  boundaries with separate temporary account/session roots and local fake providers, native resident
  attachment/detachment, session provenance and configuration isolation. Live provider checks use tiny
  prompts and never write the user's real configuration during development.
- For unpacked release qualification, run `node scripts/dist-qa.mjs --dir` after the final build on each
  platform. It prints the QA executable (`QA executable: …`): `release/qa/win-unpacked/VengeanceQA.exe`
  on Windows, `release/qa/mac-arm64/VengeanceQA.app/Contents/MacOS/VengeanceQA` on Apple silicon
  (`release/qa/mac/…` on Intel) and `release/qa/linux-unpacked/vengeance-qa` on Linux
  (`linux-arm64-unpacked` on arm64). Run `scripts/qa/engines/platform-qualification.mjs` with `QA_PACKAGED_EXE`
  pointing at it and `QA_TMP_ROOT` outside the user's home and repository (the macOS and Linux defaults
  already are), under Xvfb on a Linux host without a display. It runs packaged, integration,
  model-isolation, system-prompts, restart-safety, stop-compaction, bash-queue, session-recovery and
  resident-close suites serially against the same packaged app. This exercises both native engines
  with local providers, pi bridge loading and native helper loading through the public sign-in API. The helper
  also runs with a system-only PATH (`System32`, or `/usr/bin:/bin`) to expose missing DLLs or shared
  libraries. Inspect the generated PNGs. No installer launch or modification of a user's Vengeance
  installation is needed for this gate.
  On both macOS architectures, also run `scripts/qa/engines/background-apps.qa.mjs` against the
  packaged app in normal mode with separate temporary accounts. Observe operating-system activation
  policies during Engine RPC, SDK/provider hosts, CLI commands, both native engines and the login-shell
  probe; the main app must remain regular and background descendants must not become regular
  applications. Retain actual desktop PNGs and a red/green witness proving the observer detects the
  previous main-executable child behavior. Inspect the captures; renderer-only screenshots do not
  establish Dock behavior.
  Since 0.3.3, both macOS and both Linux architectures also qualify the official same-platform
  0.3.2 package's Engine 2 `0.10.0+vengeance.10` to the packaged candidate's build (`.12` in 0.3.3,
  `.13` in 0.3.4).
  `scripts/qa/engines/release-baseline.mjs` verifies pinned public `SHA256SUMS` and asset hashes,
  extracts the complete baseline package, verifies native inventories and macOS signatures, and
  writes `release-baseline-env.json`. Run `platform-qualification.mjs` with `QA_PLATFORM_GROUP=upgrade`
  and `QA_RELEASE_BASELINE_ENV` pointing at that JSON. The candidate-transition and resident-upgrade
  suites run serially against the final packaged candidate and retain baseline/candidate receipts.
  This follows the core nine suites and macOS visibility gate, before the navigation benchmark.
  Intel macOS packages include a source-built cryptography wheel with static OpenSSL. The lock pins
  source and build inputs; native setup verifies the bundled wheel before accepting cached Python
  readiness and includes it in runtime identity. Users need uv and network access, without a compiler
  toolchain. The Intel upgrade fixture provisions the immutable `.10` package through its public
  bootstrap command with a temporary constraint to that verified wheel. Candidate setup must run
  without that constraint or a Python override and load the bundled wheel in its refreshed environment.
  Windows's `.10` to `.11` transition evidence is retained in the prior PR qualification report;
  the Intel wheel path does not change Windows dependency resolution. pi is `1.3.0+vengeance.2` in
  0.3.2 and 0.3.3 and `.3` in 0.3.4, on the same `v1.3.0` base; its historical 1.2 to 1.3 transition
  fixture is not a release gate.
  After packaged and applicable upgrade qualification, run
  `scripts/perf/first-navigation.mjs --label <platform> --runs 3`
  against the completed built app on every platform. Retain `.shots/perf/first-navigation` JSON,
  CPU profiles and PNGs with source-bundle and native-payload hashes. This runner does not select
  `QA_PACKAGED_EXE`; its built-app measurements are separate from packaged QA. A current-platform
  run qualifies that candidate's benchmark checks, not an improvement over an unmeasured baseline
  or another platform.
- Releases come from `.github/workflows/release.yml`. A tag `vX.Y.Z` (or `vX.Y.Z-rc.N`, a prerelease) must
  match `package.json`. Each of the five platforms builds on its own clean runner without caches (Linux
  inside the pinned Ubuntu 22.04 container): engines, helper, app and packages, then the baked update
  feed check, the GLIBC gate on Linux and signature, zip and dmg verification on macOS, then the
  packaged qualification, macOS background-process gate, applicable same-platform native upgrade
  checks and built-app navigation benchmark above. The deb is
  install-tested on x64 and arm64 and the pacman package on Arch. One publish job then
  drafts the GitHub release with every package, the update files (the two `latest-mac.yml` merged),
  `SHA256SUMS` and a build provenance attestation; a maintainer reviews and publishes it. Build jobs only
  read the repository. Pull requests that touch engines, patches, the helper, packaging, toolchain pins,
  the workflow or its QA inputs, manual runs and a weekly scheduled run are dry runs that stop before
  publishing. Manual and scheduled dry runs build on clean runners like tag runs. A pull request dry run
  may instead restore and verify the engine and helper payloads cached under CI's key, which covers the
  platform, its runner label and Linux container image digest, and a hash of the engine inputs (cached
  by CI, or for Intel macOS and Linux arm64 by an earlier dry run of that pull request); its provenance
  receipt records the payloads as restored, with the cache key, or as built.
- Each platform is qualified by its own runs. CI and release dry runs are the qualification path for
  macOS and Linux; a Windows result never stands in for them. Record per-platform runs, payload hashes
  and package hashes in the release verification record. Transition and resident-upgrade suites need a
  retained baseline package of the same platform (`UPSTREAM.md`).

### 10.5 Keeping pace with upstream

- Upstream compatibility is a continuing release requirement for both backends. Follow `UPSTREAM.md`
  when changing engines, adapters, the native helper or update behavior. Keep app improvements in
  Vengeance and native fixes as a small, reproducible patch series against an exact upstream revision.
- Qualify each new upstream candidate against the public engine and app regression boundaries before
  describing it as supported. A download checksum, version probe or helper handshake alone does not
  establish protocol, authentication, restart or saved-session compatibility.
- Test whether upstream already fixes each local regression; drop superseded patches. Port only the
  remaining fixes, review conflicts, rebuild and repeat qualification. Never blindly apply patches to
  a new revision or turn an engine update into an unreviewed helper dependency upgrade.
- Keep an identified working package and recovery evidence until the successor passes. Validate saved
  history and actual executable transition using isolated copies; binary rollback does not guarantee
  that a newer session format is readable by an older engine.
- Custom engine locations do not receive automatic native self-updates. Vengeance releases deliver
  qualified builds; the app updater does not run the maintainer qualification suite or rebase patches.
  Documentation and UI must distinguish upstream releases from verified compatibility and local patch identity.

Current prompt and restart evidence is recorded in the
[qualification report](docs/ENGINE-PROMPTS-QUALIFICATION-2026-10-18.md). The separate
[navigation performance report](docs/PERFORMANCE-FIRST-NAVIGATION-2026-10-18.md) identifies its measured
builds, fixtures and remaining qualification limits.
