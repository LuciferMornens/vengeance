/**
 * Every engine setting (pi `docs/settings.md`) with its control, default and description.
 * Single source for the settings UI (rendering + search) and main-side validation of raw JSON.
 */

import { TERMINAL_SETTINGS } from './settings-terminal'

export type SettingsSectionId =
  | 'general'
  | 'models'
  | 'providers'
  | 'custom-models'
  | 'agent'
  | 'extensions'
  | 'packages'
  | 'resources'
  | 'mcp'
  | 'sessions'
  | 'terminal'
  | 'keybindings'
  | 'shortcuts'
  | 'engine'
  | 'raw'

export interface ChoiceOption {
  /** JSON value written to settings.json. */
  value: string | number | boolean
  label: string
  description?: string
}

export type SettingControl =
  | { kind: 'switch' }
  | {
      kind: 'choice'
      options: ChoiceOption[]
      /** Render as a segmented control (≤ 4 short options). */
      segmented?: boolean
      /** Allow free text values not in the list. */
      freeText?: boolean
      /** Add the custom themes the engine loads after `options`. */
      installedThemes?: boolean
    }
  | {
      kind: 'number'
      min?: number
      max?: number
      step?: number
      unit?: 'ms' | 'tokens' | 'cells' | 'lines' | 'retries'
      integer?: boolean
      slider?: boolean
    }
  | {
      kind: 'text'
      placeholder?: string
      /** Replaces `placeholder` on these systems (`PlatformInfo.os`), for examples that differ by OS. */
      placeholderByOs?: Partial<Record<'win32' | 'darwin' | 'linux', string>>
      mono?: boolean
      path?: 'file' | 'folder'
    }
  | { kind: 'list'; placeholder?: string; mono?: boolean }
  /** `"auto"` or a number. */
  | { kind: 'auto-number'; min: number; max: number }
  /** Rich editors implemented by the settings feature. */
  | {
      kind: 'custom'
      editor:
        | 'default-model'
        | 'model-thinking-levels'
        | 'enabled-models'
        | 'default-tools'
        | 'compaction-overrides'
        | 'packages'
    }

export interface SettingDef {
  /** Dotted settings.json key, e.g. `compaction.reserveTokens`. */
  key: string
  /** Other keys this row edits (searchable). */
  alsoKeys?: string[]
  section: SettingsSectionId
  /** Card the row is grouped into. */
  group: string
  label: string
  description: string
  control: SettingControl
  /** Built-in default (shown when unset). */
  default?: string | number | boolean | null
  /** Display text for a default that is not a literal (e.g. "Platform default"). */
  defaultLabel?: string
  /** "Can only be set in agent-directory settings." */
  globalOnly?: boolean
  /** Applied to running agents through an RPC command (no restart needed). */
  live?: 'steeringMode' | 'followUpMode' | 'autoCompaction' | 'autoRetry'
  /** The Vengeance UI itself honors this setting (read via `useEffectiveSetting`), instantly. */
  gui?: boolean
  /** A terminal-mode setting that Vengeance sessions also read at startup, requiring a restart. */
  alsoInSessions?: boolean
  /** Open sessions save this key themselves; a change on disk needs no restart. */
  writtenBySessions?: boolean
  /** Preferences read for each operation can change without restarting open sessions. */
  effect?: 'restart' | 'none'
  keywords?: string[]
}

const THINKING: ChoiceOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

const QUEUE: ChoiceOption[] = [
  { value: 'one-at-a-time', label: 'One at a time' },
  { value: 'all', label: 'All at once' }
]

export const THINKING_LEVEL_OPTIONS = THINKING

export const SETTINGS: SettingDef[] = [
  // ─── Models ───────────────────────────────────────────────────────────────
  {
    key: 'defaultModel',
    alsoKeys: ['defaultProvider'],
    section: 'models',
    group: 'Defaults',
    label: 'Default model',
    description:
      'Model new sessions start with. ' +
      'Leave automatic to let the engine pick the best available model.',
    control: { kind: 'custom', editor: 'default-model' },
    defaultLabel: 'Automatic',
    writtenBySessions: true,
    // Open sessions keep their own model; restarting resumes it.
    effect: 'none',
    keywords: ['provider', 'startup']
  },
  {
    key: 'defaultThinkingLevel',
    section: 'models',
    group: 'Defaults',
    label: 'Default thinking level',
    description: 'Reasoning effort for new sessions. Clamped to what the selected model supports.',
    control: { kind: 'choice', options: THINKING },
    default: 'medium',
    writtenBySessions: true,
    effect: 'none',
    keywords: ['reasoning', 'effort']
  },
  {
    key: 'modelThinkingLevels',
    section: 'models',
    group: 'Per-model thinking',
    label: 'Per-model thinking levels',
    description: 'Startup thinking level for specific models, keyed by exact provider/model.',
    control: { kind: 'custom', editor: 'model-thinking-levels' },
    keywords: ['reasoning']
  },
  {
    key: 'thinkingBudgets.minimal',
    section: 'models',
    group: 'Thinking budgets',
    label: 'Minimal budget',
    description: 'Token budget for the minimal thinking level (token-based providers).',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    defaultLabel: 'Built-in'
  },
  {
    key: 'thinkingBudgets.low',
    section: 'models',
    group: 'Thinking budgets',
    label: 'Low budget',
    description: 'Token budget for the low thinking level.',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    defaultLabel: 'Built-in'
  },
  {
    key: 'thinkingBudgets.medium',
    section: 'models',
    group: 'Thinking budgets',
    label: 'Medium budget',
    description: 'Token budget for the medium thinking level.',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    defaultLabel: 'Built-in'
  },
  {
    key: 'thinkingBudgets.high',
    section: 'models',
    group: 'Thinking budgets',
    label: 'High budget',
    description: 'Token budget for the high thinking level.',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    defaultLabel: 'Built-in'
  },
  {
    key: 'enabledModels',
    section: 'models',
    group: 'Model cycling',
    label: 'Enabled models',
    description:
      'Model patterns used for startup selection and model cycling ' +
      '(same format as --models: exact IDs, globs, optional :thinking suffix).',
    control: { kind: 'custom', editor: 'enabled-models' },
    defaultLabel: 'All available models',
    writtenBySessions: true,
    keywords: ['scope', 'scoped models', 'cycle', '--models']
  },
  {
    key: 'hideThinkingBlock',
    section: 'models',
    group: 'Thinking display',
    label: 'Hide thinking blocks',
    description: 'Hide model reasoning in the transcript.',
    control: { kind: 'switch' },
    default: false,
    gui: true
  },
  {
    key: 'showCacheMissNotices',
    section: 'models',
    group: 'Prompt caching',
    label: 'Cache notices',
    description:
      'Show notices for significant cache misses, cache warming, ' +
      'compaction usage and provider recovery.',
    control: { kind: 'switch' },
    default: false
  },
  {
    key: 'cacheWarming',
    section: 'models',
    group: 'Prompt caching',
    label: 'Cache warming',
    description:
      'Keep provider prompt caches warm during runs, or also between runs. ' +
      'Only runs when it saves money.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'off', label: 'Off' },
        { value: 'streaming', label: 'During runs' },
        { value: 'idle', label: 'Always' }
      ]
    },
    default: 'streaming',
    globalOnly: true
  },

  // ─── Agent behavior ───────────────────────────────────────────────────────
  {
    key: 'steeringMode',
    section: 'agent',
    group: 'Queued messages',
    label: 'Steering delivery',
    description: 'How messages sent while the agent works (Enter) are delivered.',
    control: { kind: 'choice', options: QUEUE, segmented: true },
    default: 'one-at-a-time',
    live: 'steeringMode',
    keywords: ['steer', 'queue']
  },
  {
    key: 'followUpMode',
    section: 'agent',
    group: 'Queued messages',
    label: 'Follow-up delivery',
    description: 'How queued follow-up messages are delivered after the agent finishes.',
    control: { kind: 'choice', options: QUEUE, segmented: true },
    default: 'one-at-a-time',
    live: 'followUpMode',
    keywords: ['queue']
  },
  {
    key: 'retry.enabled',
    section: 'agent',
    group: 'Automatic retry',
    label: 'Retry transient failures',
    description:
      'Automatically retry overloaded, rate-limited and network errors with exponential backoff.',
    control: { kind: 'switch' },
    default: true,
    live: 'autoRetry'
  },
  {
    key: 'retry.maxRetries',
    section: 'agent',
    group: 'Automatic retry',
    label: 'Maximum attempts',
    description: 'Agent-level retry attempts before giving up.',
    control: { kind: 'number', min: 0, max: 20, unit: 'retries', integer: true },
    default: 3
  },
  {
    key: 'retry.baseDelayMs',
    section: 'agent',
    group: 'Automatic retry',
    label: 'Initial delay',
    description: 'First backoff delay; doubles on each attempt.',
    control: { kind: 'number', min: 0, unit: 'ms', integer: true },
    default: 2000
  },
  {
    key: 'retry.maxAgentDelayMs',
    section: 'agent',
    group: 'Automatic retry',
    label: 'Maximum delay',
    description: 'Upper bound for the agent-level backoff delay.',
    control: { kind: 'number', min: 0, unit: 'ms', integer: true },
    default: 60000
  },
  {
    key: 'retry.provider.timeoutMs',
    section: 'agent',
    group: 'Provider requests',
    label: 'Request timeout',
    description: 'Provider request timeout. Defaults to the HTTP idle timeout.',
    control: { kind: 'number', min: 0, unit: 'ms', integer: true },
    defaultLabel: 'HTTP idle timeout'
  },
  {
    key: 'retry.provider.maxRetries',
    section: 'agent',
    group: 'Provider requests',
    label: 'Provider retries',
    description:
      'SDK-level retries. Keep at 0 unless required — ' +
      'they can delay quota and usage-limit handling.',
    control: { kind: 'number', min: 0, max: 10, unit: 'retries', integer: true },
    default: 0
  },
  {
    key: 'retry.provider.maxRetryDelayMs',
    section: 'agent',
    group: 'Provider requests',
    label: 'Max server-requested delay',
    description: 'Longest retry-after delay honored from a provider. 0 disables the limit.',
    control: { kind: 'number', min: 0, unit: 'ms', integer: true },
    default: 60000
  },
  {
    key: 'compaction.enabled',
    section: 'agent',
    group: 'Compaction',
    label: 'Automatic compaction',
    description:
      'Summarize older context when the conversation approaches the model’s context window.',
    control: { kind: 'switch' },
    default: true,
    live: 'autoCompaction',
    keywords: ['context', 'summary']
  },
  {
    key: 'compaction.reserveTokens',
    section: 'agent',
    group: 'Compaction',
    label: 'Reserved response tokens',
    description:
      'Tokens kept free for the model’s response; ' +
      'compaction triggers before this headroom is used.',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    default: 16384
  },
  {
    key: 'compaction.keepRecentTokens',
    section: 'agent',
    group: 'Compaction',
    label: 'Keep recent tokens',
    description: 'Most recent context kept verbatim instead of summarized.',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    default: 20000
  },
  {
    key: 'compaction.modelOverrides',
    section: 'agent',
    group: 'Compaction',
    label: 'Per-model overrides',
    description:
      'Token settings for specific models, keyed by exact provider/model. ' +
      'Each value falls back to the general setting.',
    control: { kind: 'custom', editor: 'compaction-overrides' }
  },
  {
    key: 'branchSummary.reserveTokens',
    section: 'agent',
    group: 'Branch summaries',
    label: 'Reserved tokens',
    description: 'Tokens reserved when summarizing an abandoned branch.',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    default: 16384
  },
  {
    key: 'branchSummary.skipPrompt',
    section: 'agent',
    group: 'Branch summaries',
    label: 'Skip summary prompt',
    description:
      'Don’t ask whether to summarize when navigating away from a branch; default to no summary.',
    control: { kind: 'switch' },
    default: false
  },
  {
    key: 'defaultTools',
    section: 'agent',
    group: 'Tools',
    label: 'Default tools',
    description:
      'Tools enabled at startup. ' +
      'Choose a full selection or add/remove tools from the defaults (+name / −name).',
    control: { kind: 'custom', editor: 'default-tools' },
    defaultLabel: 'read, bash, edit, write',
    keywords: ['codemode', 'tool_search', 'powershell', 'grep']
  },
  {
    key: 'codemode.mode',
    section: 'agent',
    group: 'Tools',
    label: 'Codemode presentation',
    description:
      '“On” notes script access on declared tools; ' +
      '“Only” routes every tool call through codemode scripts.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'on', label: 'On' },
        { value: 'only', label: 'Only' }
      ]
    },
    default: 'on'
  },
  {
    key: 'codemode.inlineBudget',
    section: 'agent',
    group: 'Tools',
    label: 'Codemode inline budget',
    description:
      'Estimated tokens the codemode description may spend on tool declarations. ' +
      '0 lists only namespaces.',
    control: { kind: 'number', min: 0, unit: 'tokens', integer: true },
    default: 3000
  },
  {
    key: 'shellPath',
    section: 'agent',
    group: 'Shell',
    label: 'Shell executable',
    description: 'Custom shell used by the bash tool and ! commands. Supports a leading ~.',
    control: {
      kind: 'text',
      path: 'file',
      mono: true,
      placeholder: 'C:\\Program Files\\Git\\bin\\bash.exe',
      placeholderByOs: { darwin: '/bin/zsh', linux: '/bin/bash' }
    },
    defaultLabel: 'Platform default'
  },
  {
    key: 'shellCommandPrefix',
    section: 'agent',
    group: 'Shell',
    label: 'Command prefix',
    description: 'Prepended to every shell command, e.g. to source aliases.',
    control: { kind: 'text', mono: true, placeholder: 'shopt -s expand_aliases' }
  },
  {
    key: 'npmCommand',
    section: 'agent',
    group: 'Shell',
    label: 'npm command',
    description: 'Command and arguments used for package lookup and installation (e.g. pnpm).',
    control: { kind: 'list', mono: true, placeholder: 'Add argument…' },
    defaultLabel: 'npm'
  },
  {
    key: 'transport',
    section: 'agent',
    group: 'Network',
    label: 'Transport',
    description: 'Preferred transport for providers that support several.',
    control: {
      kind: 'choice',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'sse', label: 'Server-sent events' },
        { value: 'websocket', label: 'WebSocket' },
        { value: 'websocket-cached', label: 'WebSocket (cached)' }
      ]
    },
    default: 'auto'
  },
  {
    key: 'httpProxy',
    section: 'agent',
    group: 'Network',
    label: 'HTTP proxy',
    description: 'Applied as HTTP_PROXY and HTTPS_PROXY for engine-managed HTTP clients.',
    control: { kind: 'text', mono: true, placeholder: 'http://proxy.local:8080' },
    globalOnly: true
  },
  {
    key: 'httpIdleTimeoutMs',
    section: 'agent',
    group: 'Network',
    label: 'HTTP idle timeout',
    description: 'Header and body idle timeout. 0 disables it.',
    control: { kind: 'number', min: 0, unit: 'ms', integer: true },
    default: 300000
  },
  {
    key: 'websocketConnectTimeoutMs',
    section: 'agent',
    group: 'Network',
    label: 'WebSocket connect timeout',
    description: 'Connection timeout for WebSocket transports. 0 disables it.',
    control: { kind: 'number', min: 0, unit: 'ms', integer: true },
    default: 15000
  },
  {
    key: 'images.autoResize',
    section: 'agent',
    group: 'Images',
    label: 'Resize images',
    description: 'Downscale images to at most 2000×2000 before sending them to a model.',
    control: { kind: 'switch' },
    default: true
  },
  {
    key: 'images.blockImages',
    section: 'agent',
    group: 'Images',
    label: 'Block images',
    description: 'Never send images to models.',
    control: { kind: 'switch' },
    default: false
  },
  {
    key: 'warnings.anthropicExtraUsage',
    section: 'agent',
    group: 'Warnings & telemetry',
    label: 'Anthropic extra-usage warning',
    description: 'Warn when subscription authentication may use paid extra usage.',
    control: { kind: 'switch' },
    default: true
  },
  {
    key: 'enableInstallTelemetry',
    section: 'agent',
    group: 'Warnings & telemetry',
    label: 'Install telemetry',
    description:
      'Anonymous install/update reporting and provider attribution headers. ' +
      'Does not control update checks.',
    control: { kind: 'switch' },
    default: true
  },
  {
    key: 'enableAnalytics',
    section: 'agent',
    group: 'Warnings & telemetry',
    label: 'Analytics',
    description: 'Opt in to analytics data sharing (experimental first-run setup only).',
    control: { kind: 'switch' },
    default: false
  },
  {
    key: 'collapseChangelog',
    section: 'agent',
    group: 'Warnings & telemetry',
    label: 'Condensed changelog',
    description: 'Show a condensed changelog after an engine update (terminal).',
    control: { kind: 'switch' },
    default: false
  },

  // ─── Sessions & context ───────────────────────────────────────────────────
  {
    key: 'sessionDir',
    section: 'sessions',
    group: 'Storage',
    label: 'Session directory',
    description:
      'Where session files are stored. Relative paths resolve from the working folder. ' +
      'An environment variable can override it.',
    control: { kind: 'text', path: 'folder', mono: true, placeholder: '~/.pi/agent/sessions' },
    defaultLabel: 'Engine session directory'
  },
  {
    key: 'sessionShareDestination',
    section: 'sessions',
    group: 'Sharing',
    label: 'Sharing destination',
    description:
      'Where Share uploads a session. ' +
      'Automatic uses Radius when signed in, otherwise GitHub gist. ' +
      'Radius requires a Radius sign-in.',
    control: {
      kind: 'choice',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'gist', label: 'GitHub gist' },
        { value: 'radius', label: 'Radius' }
      ]
    },
    default: 'auto',
    effect: 'none',
    keywords: ['share', 'gist', 'radius', 'upload']
  },
  {
    key: 'defaultProjectTrust',
    section: 'sessions',
    group: 'Project trust',
    label: 'Default project trust',
    description:
      'Fallback when a folder has project settings, extensions or skills and no saved decision. ' +
      'Vengeance sessions cannot prompt, so “Ask” behaves like “Never”.',
    control: {
      kind: 'choice',
      segmented: true,
      options: [
        { value: 'ask', label: 'Ask' },
        { value: 'always', label: 'Always' },
        { value: 'never', label: 'Never' }
      ]
    },
    default: 'ask',
    globalOnly: true,
    keywords: ['security', 'approve']
  },

  // ─── Resources ────────────────────────────────────────────────────────────
  {
    key: 'packages',
    section: 'packages',
    group: 'Installed',
    label: 'Packages',
    description:
      'npm, git or local packages that bundle extensions, skills, prompt templates and themes.',
    control: { kind: 'custom', editor: 'packages' },
    keywords: ['install', 'npm', 'git']
  },
  {
    key: 'extensions',
    section: 'resources',
    group: 'Additional paths',
    label: 'Extension paths',
    description:
      'Extension files or folders. Prefix with ! to exclude a glob, ' +
      '+ / − to include or exclude one exact path. builtin:<name> controls built-in extensions.',
    control: { kind: 'list', mono: true, placeholder: './extensions/review.ts' }
  },
  {
    key: 'skills',
    section: 'resources',
    group: 'Additional paths',
    label: 'Skill paths',
    description: 'Skill files or folders.',
    control: { kind: 'list', mono: true, placeholder: '~/skills' }
  },
  {
    key: 'prompts',
    section: 'resources',
    group: 'Additional paths',
    label: 'Prompt template paths',
    description: 'Prompt-template files or folders exposed as slash commands.',
    control: { kind: 'list', mono: true, placeholder: './prompts' }
  },
  {
    key: 'themes',
    section: 'resources',
    group: 'Additional paths',
    label: 'Theme paths',
    description: 'Theme files or folders for the terminal UI and HTML exports.',
    control: { kind: 'list', mono: true, placeholder: './themes' }
  },
  {
    key: 'enableSkillCommands',
    section: 'resources',
    group: 'Skills',
    label: 'Skill commands',
    description: 'Register every skill as a /skill:name command.',
    control: { kind: 'switch' },
    default: true
  },

  ...TERMINAL_SETTINGS
]

/** Look up a setting by dotted key. */
export function findSetting(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key || s.alsoKeys?.includes(key))
}

/** Settings keys pi writes itself and that have no visual control (still preserved in files). */
export const INTERNAL_SETTING_KEYS = ['lastChangelogVersion', 'deviceId', 'trackingId']

/** Parent object keys of nested settings (e.g. `compaction`) — valid containers in raw JSON. */
export const SETTING_CONTAINERS = [
  'thinkingBudgets',
  'compaction',
  'branchSummary',
  'retry',
  'retry.provider',
  'codemode',
  'images',
  'terminal',
  'markdown',
  'warnings'
]
