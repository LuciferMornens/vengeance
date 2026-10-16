/**
 * Composer feature: floating input with attachments, @mentions, /commands (engine + GUI-mapped built-ins),
 * `!bash`, steer/follow-up queue and per-agent drafts. Mounted by the shell as `<Composer agentId/>`.
 */
export { Composer } from './Composer'
export { focusComposer, setDraftText } from './drafts'
export { COMPOSER_ACTIONS, CYCLE_MODEL_BACKWARD_HOTKEY } from './actions'
