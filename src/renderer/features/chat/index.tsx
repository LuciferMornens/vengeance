/**
 * Chat feature: transcript (messages, markdown, thinking, tool activity), session header and the
 * empty-session hero. Mounted by the shell as <SessionHeader/> and <Transcript/>.
 *
 * Shared pickers for other features:
 * - `ModelPicker({ agentId, children?, side?, align?, open?, onOpenChange? })`: the searchable model popover
 *   (`get_available_models` → `set_model`). `children` is a custom trigger (asChild); without it the picker
 *   renders its own model pill. Defaults: `side="bottom"`, `align="end"`.
 * - `ModelRow({ model, active?, ready?, badge?, onSelect? })`: one model row (a cmdk `Command.Item`; mount it
 *   inside a `<Command>`).
 * - `ThinkingControl({ agentId, children?, align? })`: thinking-level menu; `ThinkingMeter` is its level glyph.
 * - `ContextRing({ percent, size? })`: the one context gauge (clamped at 100 %, over-limit tint);
 *   `contextPercentLabel` / `isOverContextLimit` format it. `ContextMeter({ usage })` is the composer footer
 *   gauge, `ContextUsage({ agentId })` the header gauge with cost + breakdown.
 * - `useThinkingHidden(cwd, engine)` / `toggleThinkingVisibility()`: engine-scoped thinking visibility (Ctrl+T).
 */
import './chat.css'
import './actions'

export { Transcript } from './Transcript'
export { SessionHeader } from './SessionHeader'
export { SessionEmptyState } from './EmptyState'
export {
  insetCaretClass,
  ModelPicker,
  ModelRow,
  ProviderTile,
  providerLabel,
  type ModelPickerProps,
  type ModelRowProps
} from './ModelPicker'
export { ThinkingControl, ThinkingMeter, type ThinkingControlProps } from './ThinkingControl'
export {
  ContextMeter,
  ContextRing,
  ContextUsage,
  contextPercentLabel,
  isOverContextLimit
} from './ContextRing'
export { useThinkingHidden, toggleThinkingVisibility } from './thinking-visibility'
