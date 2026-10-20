# Vengeance 0.3.4

Vengeance 0.3.4 gives each conversation its own instructions and shows the live state of every MCP
server a conversation uses, with Reconnect beside it. Both engines gain a native patch that reports
MCP status to the app. Release QA also stops slow Engine 2 daemons more patiently.

## Downloads and updating

| Platform            | Files                                     |
| ------------------- | ----------------------------------------- |
| Windows x64         | `Vengeance-Setup-0.3.4.exe`               |
| macOS Apple silicon | `Vengeance-0.3.4-mac-arm64.dmg` or `.zip` |
| macOS Intel         | `Vengeance-0.3.4-mac-x64.dmg` or `.zip`   |
| Linux x64           | AppImage, deb, rpm, pacman and tar.gz     |
| Linux arm64         | AppImage, deb, rpm and tar.gz             |

Use the [GitHub release page](https://github.com/LuciferMornens/vengeance/releases) and the
[install guide](https://github.com/LuciferMornens/vengeance/blob/v0.3.4/README.md#install).
Verify downloads against `SHA256SUMS`, or check build provenance with
`gh attestation verify <file> --repo LuciferMornens/vengeance`.

On 0.3.1, 0.3.2 or 0.3.3, **Settings → Updates** offers the next published release. The Windows
installer and Linux AppImage can download and install updates; macOS and other Linux packages open
the release page for manual or package-manager installation. On 0.3.0, install by hand as the
[0.3.1 notes](https://github.com/LuciferMornens/vengeance/blob/v0.3.4/docs/RELEASE-0.3.1.md)
explain. Settings, saved sessions and sign-ins stay in place.

## What's new

- **Instructions for one conversation.** The session header's instructions control, `/instructions`
  on both engines and the command palette open one dialog for that conversation. _Add to engine
  prompt_, the default, adds your text after a saved `APPEND_SYSTEM.md`. _Replace foundation_
  replaces the engine's foundation and wins over `SYSTEM.md`. Either way each engine keeps its
  runtime sections: project context, skills, MCP and the working folder, plus Engine 2's date,
  environment, capability and role sections. The header control is highlighted while a conversation
  has instructions.
- **Applied with a guarded restart.** _Save and restart_ and _Remove_ refuse while the conversation
  is busy and keep your draft. On Engine 2 the restart includes the engine's other idle sessions.
  Instructions stay with the conversation when it is resumed, forked or moved with
  **Switch engine**, and are deleted when it moves to the trash.
- **The assembled prompt lives with its conversation.** _View assembled prompt_ in the same dialog
  shows the prompt the engine assembled, names the session and says it is a snapshot. Settings keeps
  the read-only foundation view and editing of global and project prompt files; the conversation's
  dialog offers _Restart_ to pick up files saved since it started.
- **Live MCP status above the composer.** A chip shows how many of the conversation's MCP servers
  are connected and how many need attention, and keeps itself up to date. Its panel lists each
  server with its state (connected with its tool count, connecting, needs sign-in, failed with its
  error, off, or blocked until the folder is trusted), Reconnect, sign-in and, on the Engine, an
  on/off switch. In a trusted folder the switch changes that folder alone; otherwise the panel says
  when a switch saves to the global `mcp.json` for every folder.
- **MCP status in Settings.** **Settings → MCP** shows each server's state across the folder's open
  sessions, the worst first with how many sessions are in each state, and reconnects the server in
  the sessions that run it.
- **Engine 2 reports from its running kernel.** Status comes from the session's kernel, which a
  status read never starts. Until the kernel runs, the chip reads `not started` and shows the
  configured states. Engine 2 turns servers on and off in Settings.
- **Status chips open their full text.** Every extension status chip above the composer, including
  the `+N` overflow, opens the full text it abbreviates with each extension's name.
- **Engine builds.** Engine `1.3.0+vengeance.3` adds patch 0009: its built-in MCP extension reports
  each server's state, tool count, sign-in need and error, and takes reconnect, enable, disable and
  sign-out requests from the app. Engine 2 `0.10.0+vengeance.13` adds patch 0024: `get_mcp_status`,
  which is read-only, and `reconnect_mcp_server` answer from the session's kernel. Both patches are
  additive; `/mcp`, prompts and saved formats are unchanged. Both source builds keep their pinned
  stable upstream bases and update with Vengeance.
- **Maintenance.** Release QA gives a slow Engine 2 daemon a 15-second budget to stop gracefully and
  never force-kills a process whose identity it cannot verify
  ([#20](https://github.com/LuciferMornens/vengeance/pull/20)). Dependencies move to TanStack Virtual
  3.14.17 and Radix UI 1.8.0 ([#17](https://github.com/LuciferMornens/vengeance/pull/17)). CodeQL no
  longer tries to analyze the macOS QA observer as Swift, and Dependabot leaves the Vite 8 and
  TypeScript 7 majors for deliberate adoption ([#19](https://github.com/LuciferMornens/vengeance/pull/19)).

## Limits

Temporary chats that cannot restart (Engine 2 temporary chats, and Engine temporary chats with
messages) cannot apply instructions. When an MCP adapter extension replaces the Engine's built-in
MCP support, the panel shows the status that adapter publishes, and its actions run the adapter's
`/mcp` commands in the conversation.

The [existing platform and feature limits](https://github.com/LuciferMornens/vengeance/blob/v0.3.4/README.md#good-to-know)
still apply. macOS packages are ad-hoc signed without Developer ID signing or notarization and
cannot replace themselves through the updater. Live provider sign-in and paid-provider behavior
remain outside the local qualification scope.

The [qualification checkpoint](https://github.com/LuciferMornens/vengeance/blob/v0.3.4/docs/RELEASE-QUALIFICATION-0.3.4.md)
records local and CI evidence. The tag run and the published release's receipts identify the
qualified shipping bytes.
