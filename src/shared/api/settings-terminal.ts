import type { ChoiceOption, SettingDef } from './settings-schema'

const AUTO_BOOL: ChoiceOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: true, label: 'On' },
  { value: false, label: 'Off' }
]

export const TERMINAL_SETTINGS: SettingDef[] = [
  {
    key: 'theme',
    section: 'terminal',
    group: 'Appearance',
    label: 'Terminal theme',
    description:
      'Colors of the terminal UI and of HTML exports. “System” derives them from the terminal.',
    control: {
      kind: 'choice',
      freeText: true,
      installedThemes: true,
      options: [
        { value: 'system', label: 'System' },
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' }
      ]
    },
    default: 'system',
    alsoInSessions: true,
    keywords: ['export', 'html', 'colors']
  },
  {
    key: 'quietStartup',
    section: 'terminal',
    group: 'Appearance',
    label: 'Quiet startup',
    description: 'Hide the startup header and loaded-resource listing, or keep only the header.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: false, label: 'Off' },
        { value: 'header', label: 'Header only' },
        { value: true, label: 'Quiet' }
      ]
    },
    default: false
  },
  {
    key: 'tuiMode',
    section: 'terminal',
    group: 'Fullscreen',
    label: 'Terminal UI mode',
    description: 'Fullscreen alternate screen or regular scrollback.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'fullscreen', label: 'Fullscreen' },
        { value: 'regular', label: 'Regular' }
      ]
    },
    default: 'fullscreen'
  },
  {
    key: 'fullscreenExitOutput',
    section: 'terminal',
    group: 'Fullscreen',
    label: 'Output on exit',
    description: 'What is printed when fullscreen mode exits.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'transcript', label: 'Transcript' },
        { value: 'resume-hint', label: 'Resume hint' }
      ]
    },
    default: 'transcript'
  },
  {
    key: 'fullscreenScrollbar',
    section: 'terminal',
    group: 'Fullscreen',
    label: 'Scrollbar',
    description: 'Fullscreen transcript scrollbar.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'auto', label: 'Auto' },
        { value: 'always', label: 'Always' },
        { value: 'hidden', label: 'Hidden' }
      ]
    },
    default: 'auto'
  },
  {
    key: 'fullscreenCopyOnSelect',
    section: 'terminal',
    group: 'Fullscreen',
    label: 'Copy on select',
    description: 'Copy selected text automatically in fullscreen mode.',
    control: { kind: 'switch' },
    default: true
  },
  {
    key: 'fullscreenWheelScrollLines',
    section: 'terminal',
    group: 'Fullscreen',
    label: 'Wheel scroll lines',
    description: 'Lines per mouse-wheel event (1–100), or automatic acceleration.',
    control: { kind: 'auto-number', min: 1, max: 100 },
    default: 'auto'
  },
  {
    key: 'editorPaddingX',
    section: 'terminal',
    group: 'Layout',
    label: 'Editor padding',
    description: 'Horizontal editor padding in cells.',
    control: {
      kind: 'number',
      min: 0,
      max: 3,
      step: 1,
      unit: 'cells',
      integer: true,
      slider: true
    },
    default: 0
  },
  {
    key: 'outputPad',
    section: 'terminal',
    group: 'Layout',
    label: 'Transcript padding',
    description: 'Horizontal padding for messages, tool output and summaries.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 0, label: 'None' },
        { value: 1, label: '1 cell' }
      ]
    },
    default: 1
  },
  {
    key: 'autocompleteMaxVisible',
    section: 'terminal',
    group: 'Layout',
    label: 'Autocomplete entries',
    description: 'Visible autocomplete entries (3–20).',
    control: { kind: 'number', min: 3, max: 20, step: 1, integer: true, slider: true },
    default: 5
  },
  {
    key: 'showHardwareCursor',
    section: 'terminal',
    group: 'Layout',
    label: 'Hardware cursor',
    description: 'Show the terminal cursor while positioning it for input methods.',
    control: { kind: 'switch' },
    default: false
  },
  {
    key: 'externalEditor',
    section: 'terminal',
    group: 'Interaction',
    label: 'External editor',
    description:
      'Command opened by the external-editor key binding. ' +
      'Falls back to $VISUAL, $EDITOR, then the platform default.',
    control: { kind: 'text', mono: true, placeholder: 'code --wait' },
    defaultLabel: '$VISUAL / $EDITOR'
  },
  {
    key: 'doubleEscapeAction',
    section: 'terminal',
    group: 'Interaction',
    label: 'Double Escape',
    description: 'Action for double Escape with an empty editor.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'tree', label: 'Tree' },
        { value: 'fork', label: 'Fork' },
        { value: 'none', label: 'Nothing' }
      ]
    },
    default: 'tree',
    gui: true
  },
  {
    key: 'treeFilterMode',
    section: 'terminal',
    group: 'Interaction',
    label: 'Tree filter',
    description: 'Initial filter used by /tree.',
    control: {
      kind: 'choice',
      options: [
        { value: 'default', label: 'Default' },
        { value: 'no-tools', label: 'Hide tools' },
        { value: 'user-only', label: 'User messages only' },
        { value: 'labeled-only', label: 'Labeled only' },
        { value: 'all', label: 'Everything' }
      ]
    },
    default: 'default',
    gui: true
  },
  {
    key: 'terminal.showImages',
    section: 'terminal',
    group: 'Terminal capabilities',
    label: 'Inline images',
    description: 'Display inline images when the terminal supports them.',
    control: { kind: 'switch' },
    default: true
  },
  {
    key: 'terminal.imageWidthCells',
    section: 'terminal',
    group: 'Terminal capabilities',
    label: 'Image width',
    description: 'Preferred inline image width.',
    control: { kind: 'number', min: 1, unit: 'cells', integer: true },
    default: 60
  },
  {
    key: 'terminal.images',
    section: 'terminal',
    group: 'Terminal capabilities',
    label: 'Image protocol',
    description: 'Override inline-image protocol detection.',
    control: {
      kind: 'choice',
      options: [
        { value: 'auto', label: 'Auto-detect' },
        { value: 'kitty', label: 'Kitty' },
        { value: 'iterm2', label: 'iTerm2' },
        { value: false, label: 'Disabled' }
      ]
    },
    default: 'auto'
  },
  {
    key: 'terminal.hyperlinks',
    section: 'terminal',
    group: 'Terminal capabilities',
    label: 'Hyperlinks',
    description: 'Override OSC 8 hyperlink detection.',
    control: { kind: 'choice', options: AUTO_BOOL, segmented: true },
    default: 'auto'
  },
  {
    key: 'terminal.trueColor',
    section: 'terminal',
    group: 'Terminal capabilities',
    label: 'True color',
    description: 'Override 24-bit color detection.',
    control: { kind: 'choice', options: AUTO_BOOL, segmented: true },
    default: 'auto'
  },
  {
    key: 'terminal.clearOnShrink',
    section: 'terminal',
    group: 'Terminal capabilities',
    label: 'Clear on shrink',
    description: 'Clear empty rows when rendered content shrinks.',
    control: { kind: 'switch' },
    default: false
  },
  {
    key: 'terminal.showTerminalProgress',
    section: 'terminal',
    group: 'Terminal capabilities',
    label: 'Tab progress',
    description: 'Show OSC 9;4 progress in the terminal tab.',
    control: { kind: 'switch' },
    default: false
  },
  {
    key: 'markdown.codeBlockIndent',
    section: 'terminal',
    group: 'Markdown',
    label: 'Code block indent',
    description: 'Prefix used to indent rendered code blocks.',
    control: { kind: 'text', mono: true, placeholder: '2 spaces' },
    default: '  '
  },
  {
    key: 'markdown.mermaid',
    section: 'terminal',
    group: 'Markdown',
    label: 'Mermaid diagrams',
    description: 'Render Mermaid diagrams while streaming, only when final, or never.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'off', label: 'Off' },
        { value: 'final', label: 'Final' },
        { value: 'streaming', label: 'Streaming' }
      ]
    },
    default: 'streaming',
    gui: true
  }
]
