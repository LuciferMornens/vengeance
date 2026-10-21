import type { FlatSessionTree } from '../engine-types'
import type { EngineId } from './engine'

/**
 * Session browser: list/rename/trash/branch/label/export/import/share persisted pi sessions (JSONL files).
 * Handlers live in src/main/ipc/sessions.ts (logic in src/main/features/sessions/).
 * Every file operation is limited to session folders the engine uses (pi's sessions root and custom
 * `sessionDir`s seen while listing). Persisted prefs live under AppPersistedState.features.sessions.
 */

/** One persisted session file (mirrors pi's `SessionInfo`, dates as epoch ms, transcript text bounded). */
export interface SessionListItem {
  engine?: EngineId
  lineage?: SessionLineage
  /** Absolute path to the `.jsonl` file (the identity). */
  path: string
  id: string
  /** Working directory the session was started in ('' for very old sessions). */
  cwd: string
  /** User-defined display name (`session_info` entry). */
  name?: string
  /** Set when the session was forked/cloned from another file. */
  parentSessionPath?: string
  createdAt: number
  /** Last activity (epoch ms). */
  modifiedAt: number
  /** Message entries in the file (pi's count). */
  messageCount: number
  firstMessage: string
  /** Lower-cased, bounded transcript text for search. */
  searchText: string
  /** A subagent run's session that pi-subagents stores inside its parent's folder (`<parent>/<run id>/run-<n>/`). */
  subagentRun?: { parentPath: string; runId: string }
}

/** Native family identity; a source-session path alone can also describe a fork. */
export interface SessionLineage {
  parentSessionPath?: string
  parentSessionId?: string
  parentNativeAgentId?: string
  depth?: number
  childId?: string
  runtimeKind?: string
}

export interface SessionListQuery {
  engine?: EngineId
  /** Workspace folder, or null for every workspace. */
  cwd: string | null
}

export interface SessionListResult {
  sessions: SessionListItem[]
  warning?: string
  /** Directory the sessions were read from (custom `sessionDir` or pi's per-workspace default). */
  sessionDir: string
}

export interface WorkspaceDiscovery {
  path: string
  lastActivityAt: number
  engine?: EngineId
}

/** Folders with saved history. */
export interface WorkspaceScan {
  workspaces: WorkspaceDiscovery[]
  /** False when some saved history could not be read, so a folder with history may be missing. */
  complete: boolean
}

export interface WorkspaceDiscoveryResult extends WorkspaceScan {
  /** Known workspace folders that were deleted: missing from a parent folder that is still there. */
  gone: string[]
}

export interface SessionIdentity {
  cwd: string
  engine: EngineId
  lineage?: SessionLineage
}

export interface ResolveSessionArgs {
  reference: string
  cwd: string
  engine: EngineId
}

export interface InspectImportArgs {
  sourcePath: string
  cwd: string
  engine: EngineId
}

/** A user message that can be forked from (the new session ends right before it). */
export interface ForkPoint {
  entryId: string
  /** Parent of the user message (null when it is the first entry). */
  parentId: string | null
  text: string
  /** epoch ms */
  timestamp: number
}

export interface BranchSessionArgs {
  engine?: EngineId
  sessionPath: string
  /** The new session contains the path root → this entry (inclusive). */
  entryId: string
}

export interface SetSessionLabelArgs {
  engine?: EngineId
  sessionPath: string
  entryId: string
  /** Empty or undefined clears the label. */
  label?: string
}

export type SessionExportFormat = 'html' | 'jsonl'

export interface ExportSessionArgs {
  engine?: EngineId
  /** Session file ('' for an ephemeral session, which needs `agentId`). */
  sessionPath: string
  /** Export through this running engine (its live leaf and `export_html`) instead of the file. */
  agentId?: string
  /** Suggested file name (without extension). */
  title?: string
  /** Pre-selected format in the save dialog; the extension the user keeps decides. */
  format: SessionExportFormat
  /**
   * Write here without a save dialog (`/export <path>`). Like the engine's /export, a `.jsonl` path exports
   * JSONL and anything else HTML (`format` is ignored); relative paths resolve against the session's folder.
   */
  outputPath?: string
}

export interface ExportSessionResult {
  path: string
  format: SessionExportFormat
}

/** A `.jsonl` file the user picked for import, read without modifying it. */
export interface ImportCandidate {
  engine?: EngineId
  sourcePath: string
  fileName: string
  sessionId: string
  /** Working directory stored in the file header. */
  cwd: string
  /** That folder exists on this machine (otherwise the import continues in the target workspace). */
  cwdExists: boolean
  name?: string
  firstMessage: string
  /** User and assistant messages. */
  messageCount: number
  /** epoch ms of the header. */
  createdAt: number
}

export interface ImportSessionArgs {
  engine?: EngineId
  sourcePath: string
  /** Workspace to continue in when the stored folder no longer exists. */
  fallbackCwd: string
}

export interface ImportSessionResult {
  engine?: EngineId
  /** The copy inside the session folder (the original is never modified). */
  path: string
  /** Folder the engine runs in. */
  cwd: string
  /** The stored folder was missing and the copy now points at `fallbackCwd`. */
  movedToFallback: boolean
}

export interface ShareSessionArgs {
  engine?: EngineId
  sessionPath: string
  agentId?: string
  title?: string
  /** The destination reviewed in the share dialog; a change requires another review. */
  destination?: ShareDestination
}

export type ShareDestination = 'gist' | 'radius'

/** The selected backend's destination and account readiness for this session. */
export type ShareReadiness =
  | { ready: true; destination: ShareDestination }
  | {
      ready: false
      destination: ShareDestination
      reason: 'missing-gh' | 'signed-out' | 'radius-signed-out'
      detail?: string
    }

export type ShareSessionResult =
  { destination: 'gist'; url: string; gistUrl: string } | { destination: 'radius'; url: string }

export interface SessionsInvokeMap {
  'sessions:workspaces': [result: WorkspaceDiscoveryResult]
  'sessions:describe': [path: string, result: SessionIdentity & { cwdExists: boolean }]
  'sessions:pick-import-for-engine': [engine: EngineId, result: ImportCandidate | null]
  'sessions:inspect-import': [args: InspectImportArgs, result: ImportCandidate]
  'sessions:resolve': [args: ResolveSessionArgs, result: SessionIdentity & { path: string }]
  'sessions:list': [query: SessionListQuery, result: SessionListResult]
  /** Rename a session that is not open in an engine (open sessions use `set_session_name`). */
  'sessions:rename': [path: string, name: string, result: void]
  /** Move a session file to the recycle bin. */
  'sessions:trash': [path: string, result: void]
  /** New session file with the path root → entry of an existing session; returns its path. */
  'sessions:branch': [args: BranchSessionArgs, result: string]
  /** User messages on the active branch of a session file (fork targets for closed sessions). */
  'sessions:fork-points': [path: string, result: ForkPoint[]]
  /**
   * A saved session's menu opened or its rename started: load what editing saved session files needs, so the
   * first such operation answers at once. Safe to call any time and repeatedly.
   */
  'sessions:prewarm': [engine: EngineId, result: void]
  /** Entry tree of a session file that is not open in an engine. */
  /** The entry tree of a closed session file (same form as RPC `get_tree`). */
  'sessions:tree': [path: string, result: FlatSessionTree]
  /** Set or clear an entry label in a session file that is not open in an engine (open ones use the bridge). */
  'sessions:set-label': [args: SetSessionLabelArgs, result: void]
  /** Working directory stored in a session file's header. */
  'sessions:cwd': [path: string, result: string]
  /** Ask for a destination (or use `outputPath`) and export HTML or JSONL; null when cancelled. */
  'sessions:export': [args: ExportSessionArgs, result: ExportSessionResult | null]
  /** Ask for a `.jsonl` file to import and describe it; null when cancelled. */
  'sessions:pick-import': [result: ImportCandidate | null]
  /** Copy a picked file into the session folder of the folder it continues in (like the engine's /import). */
  'sessions:import': [args: ImportSessionArgs, result: ImportSessionResult]
  'sessions:share-readiness': [args: ShareSessionArgs, result: ShareReadiness]
  /** Share through the selected backend's native destination. */
  'sessions:share': [args: ShareSessionArgs, result: ShareSessionResult]
}

export interface SessionsEventMap {
  /** Something changed under the watched sessions root (debounced). */
  'sessions:changed': { root: string }
}

export type SessionScope = 'workspace' | 'all'

export interface SessionsPrefs {
  /** Folders explicitly removed from automatic workspace discovery. */
  hiddenWorkspaces?: string[]
  /** Pinned session file paths. */
  pinned?: string[]
  /** Sidebar list scope. */
  scope?: SessionScope
  /** Collapsed workspace sections in the "All workspaces" view (cwd keys). */
  collapsed?: string[]
}
