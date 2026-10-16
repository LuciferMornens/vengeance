/**
 * Chat feature IPC (transcript, session header, empty state). The chat UI reads persisted sessions through
 * `sessions:list` and drives the engine over RPC, so it declares no channels of its own.
 */

export interface ChatInvokeMap {}

export interface ChatEventMap {}

export interface ChatPrefs {}
