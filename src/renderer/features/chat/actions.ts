import { Brain, ChevronsUpDown } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { matchesCombo } from '../../lib/keybindings'
import { toggleToolsExpanded } from '../tools'
import { toggleThinkingVisibility } from './thinking-visibility'

/** Transcript view toggles, with pi's TUI keys: Ctrl+T (`app.thinking.toggle`), Ctrl+O (`app.tools.expand`). */
const VIEW_TOGGLES = [
  { id: 'chat.thinking.toggle', title: 'Show or hide thinking', keywords: ['reasoning', 'hideThinkingBlock'], hotkey: 'mod+t', icon: Brain, run: toggleThinkingVisibility },
  { id: 'chat.tools.expand', title: 'Expand or collapse tool output', keywords: ['tools', 'collapse', 'expand'], hotkey: 'mod+o', icon: ChevronsUpDown, run: toggleToolsExpanded }
]

registerActions(VIEW_TOGGLES.map((action) => ({ ...action, group: 'View' })))

window.addEventListener(
  'keydown',
  (event) => {
    const action = VIEW_TOGGLES.find((a) => matchesCombo(event, a.hotkey))
    if (!action || event.repeat) return
    event.preventDefault()
    event.stopPropagation()
    action.run()
  },
  { capture: true }
)
