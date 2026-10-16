/**
 * Sessions feature: session browser (left sidebar), fork/clone/rename/export/share/import/delete, workspace switcher.
 *
 * For other features:
 * - `openSessionFile(path, { cwd? })`: the one way to open a saved session. Focuses the agent that already
 *   has the file open (one engine per session file), else resumes it in a new engine.
 * - `renameSession(target, name)` with `targetForAgent(agentId)`: rename (clears an extension-set title).
 * - `forkAt`, `continueFrom`, `goToPoint`: fork / branch into a new file / move in place.
 * - `restoreOpenSessions()`: boot-time reopen of the sessions open at the last quit (the shell calls it once).
 * - Palette actions: session.fork, session.clone, session.tree, session.resume, session.rename,
 *   session.export, session.exportJsonl, session.share, session.import, session.newEphemeral.
 */
export { SessionSidebar } from './SessionSidebar'
export { LiveDot } from './LiveDot'
export { activateAgent, continueFrom, forkAt, goToPoint, openSessionFile, renameSession, targetForAgent } from './actions'
export { agentSessionFile, agentTitle, liveState, stripWorkspacePrefix } from './model'
export { restoreOpenSessions } from './restore'
