export type PrimeSettingsSection =
  'models' | 'agent' | 'resources' | 'sessions' | 'terminal' | 'engine'

export interface PrimeFieldDefinition {
  key: string
  label: string
  description?: string
  control:
    | { kind: 'boolean' }
    | { kind: 'number'; unit?: 'ms' | 'tokens'; minimum?: number }
    | { kind: 'text'; browse?: 'file' | 'folder'; placeholder?: string }
    | { kind: 'list'; ordered?: boolean; placeholder?: string }
    | { kind: 'choice'; options: Array<{ value: string; label: string }> }
    | { kind: 'limit'; special: 'off' | 'unlimited'; unit?: 'ms' | 'tokens' }
}

interface PrimeSettingsGroup {
  section: PrimeSettingsSection
  title: string
  fields: PrimeFieldDefinition[]
}

function booleanField(key: string, label: string, description?: string): PrimeFieldDefinition {
  return { key, label, description, control: { kind: 'boolean' } }
}

function numberField(
  key: string,
  label: string,
  description?: string,
  unit?: 'ms' | 'tokens',
  minimum = 0
): PrimeFieldDefinition {
  return { key, label, description, control: { kind: 'number', unit, minimum } }
}

function textField(
  key: string,
  label: string,
  description?: string,
  browse?: 'file' | 'folder'
): PrimeFieldDefinition {
  return { key, label, description, control: { kind: 'text', browse } }
}

function listField(
  key: string,
  label: string,
  description?: string,
  ordered = false
): PrimeFieldDefinition {
  return { key, label, description, control: { kind: 'list', ordered } }
}

function choiceField(
  key: string,
  label: string,
  options: Array<[string, string]>,
  description?: string
): PrimeFieldDefinition {
  return {
    key,
    label,
    description,
    control: {
      kind: 'choice',
      options: options.map(([value, optionLabel]) => ({ value, label: optionLabel }))
    }
  }
}

function limitField(
  key: string,
  label: string,
  special: 'off' | 'unlimited',
  description?: string,
  unit?: 'ms' | 'tokens'
): PrimeFieldDefinition {
  return { key, label, description, control: { kind: 'limit', special, unit } }
}

export const PRIME_SERVICE_TIERS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'default', label: 'Standard' },
  { value: 'flex', label: 'Flex' },
  { value: 'scale', label: 'Scale' },
  { value: 'priority', label: 'Priority' },
  { value: 'ultrafast', label: 'Ultrafast' }
]

/** The `/traces` actions, shared by the slash command and the traces panel. */
export const PRIME_TRACE_ACTIONS: readonly string[] = [
  'status',
  'on',
  'off',
  'preview',
  'upload',
  'upload-current',
  'upload-all',
  'login'
]

// Native queue and transport values use kebab-case, per pa-core/settings/types.rs.
export const PRIME_SETTINGS_GROUPS: PrimeSettingsGroup[] = [
  {
    section: 'models',
    title: 'Model defaults',
    fields: [
      textField(
        'defaultProvider',
        'Default provider',
        'Provider identifier used for new sessions.'
      ),
      textField('defaultModel', 'Default model', 'Model identifier used for new sessions.'),
      choiceField('defaultThinkingLevel', 'Thinking level', [
        ['off', 'Off'],
        ['minimal', 'Minimal'],
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['xhigh', 'Extra high'],
        ['max', 'Maximum']
      ]),
      choiceField(
        'defaultServiceTier',
        'Service tier',
        PRIME_SERVICE_TIERS.map(({ value, label }) => [value, label]),
        'Applied when the selected provider and model support this tier.'
      ),
      listField(
        'enabledModels',
        'Model cycling',
        'Model references available when cycling models.'
      ),
      listField(
        'allowedModels',
        'Allowed models',
        'A model outside this list is rejected. Reset to allow all models.'
      ),
      listField('recentModels', 'Recent models', 'Model history kept by Engine 2.', true)
    ]
  },
  {
    section: 'models',
    title: 'Specialist models',
    fields: [
      textField('subagentDefaultModel', 'Subagent model', 'Default model for delegated work.'),
      textField('auxiliaryModel', 'Auxiliary model', 'Model for auxiliary engine operations.'),
      textField(
        'providerBackupModel',
        'Backup model',
        'Fallback model reference for provider recovery.'
      ),
      textField(
        'imageModel',
        'Image model',
        'Handles image turns when the session model accepts text only.'
      )
    ]
  },
  {
    section: 'models',
    title: 'Thinking budgets',
    fields: [
      numberField('thinkingBudgets.minimal', 'Minimal thinking', undefined, 'tokens'),
      numberField('thinkingBudgets.low', 'Low thinking', undefined, 'tokens'),
      numberField('thinkingBudgets.medium', 'Medium thinking', undefined, 'tokens'),
      numberField('thinkingBudgets.high', 'High thinking', undefined, 'tokens')
    ]
  },
  {
    section: 'agent',
    title: 'Messages and delegation',
    fields: [
      choiceField('steeringMode', 'Steering queue', [
        ['all', 'All messages'],
        ['one-at-a-time', 'One at a time']
      ]),
      choiceField('followUpMode', 'Follow-up queue', [
        ['all', 'All messages'],
        ['one-at-a-time', 'One at a time']
      ]),
      numberField(
        'rlmMaxDepth',
        'Maximum subagent depth',
        'How many levels of nested delegation the engine permits.'
      ),
      booleanField(
        'factory.enabled',
        'Agent factory',
        'Allow the native agent factory to run specifications.'
      )
    ]
  },
  {
    section: 'agent',
    title: 'Autonomous execution',
    fields: [
      limitField(
        'autonomous.maxContinuations',
        'Continuation limit',
        'unlimited',
        'Default budget when autonomous execution is enabled.'
      ),
      limitField('autonomous.maxTurns', 'Turn limit', 'unlimited'),
      limitField('autonomous.maxTokens', 'Token limit', 'unlimited', undefined, 'tokens'),
      limitField('autonomous.timeoutMs', 'Time limit', 'unlimited', undefined, 'ms')
    ]
  },
  {
    section: 'agent',
    title: 'Automatic refinement',
    fields: [
      booleanField('autoRefine.enabled', 'Refine automatically'),
      numberField('autoRefine.turnInterval', 'Turns between refinements'),
      booleanField('autoRefine.compact', 'Compact after refinement'),
      numberField('autoRefine.cooldownMs', 'Refinement cooldown', undefined, 'ms')
    ]
  },
  {
    section: 'agent',
    title: 'Compaction and branches',
    fields: [
      booleanField('compaction.enabled', 'Automatic compaction'),
      numberField('compaction.reserveTokens', 'Compaction reserve', undefined, 'tokens'),
      numberField('compaction.keepRecentTokens', 'Keep recent context', undefined, 'tokens'),
      booleanField('compaction.agentCallable', 'Agent-initiated compaction'),
      numberField('branchSummary.reserveTokens', 'Branch summary reserve', undefined, 'tokens'),
      booleanField('branchSummary.skipPrompt', 'Skip branch summary prompt')
    ]
  },
  {
    section: 'agent',
    title: 'Retry and failover',
    fields: [
      booleanField('retry.enabled', 'Retry failed requests'),
      numberField('retry.maxRetries', 'Maximum retries'),
      numberField('retry.baseDelayMs', 'Initial retry delay', undefined, 'ms'),
      booleanField(
        'retry.failover.enabled',
        'Fail over to another provider',
        'Try another configured provider serving the same model.'
      ),
      numberField('retry.failover.maxRetries', 'Retries before failover'),
      numberField('retry.failover.baseDelayMs', 'Initial failover delay', undefined, 'ms'),
      numberField('retry.failover.maxDelayMs', 'Maximum failover delay', undefined, 'ms'),
      numberField('retry.provider.timeoutMs', 'Provider timeout', undefined, 'ms'),
      numberField('retry.provider.maxRetryDelayMs', 'Maximum provider retry delay', undefined, 'ms')
    ]
  },
  {
    section: 'agent',
    title: 'Provider usage limits',
    fields: [
      booleanField('retry.provider.waitForUsage.enabled', 'Wait for usage to reset'),
      numberField('retry.provider.waitForUsage.baseDelayMs', 'Initial wait', undefined, 'ms'),
      numberField(
        'retry.provider.waitForUsage.maxDelayMs',
        'Maximum wait between attempts',
        undefined,
        'ms'
      ),
      numberField('retry.provider.waitForUsage.maxAttempts', 'Maximum wait attempts'),
      numberField('retry.provider.waitForUsage.maxWaitMs', 'Total wait limit', undefined, 'ms'),
      booleanField(
        'retry.provider.waitForUsage.pauseUntilReset',
        'Pause until provider reset',
        'Park the session when the provider reset is beyond the bounded wait.'
      ),
      numberField(
        'retry.provider.waitForUsage.maxPauseMs',
        'Maximum pause duration',
        undefined,
        'ms'
      ),
      numberField('retry.provider.waitForUsage.maxParks', 'Maximum pauses per quota episode')
    ]
  },
  {
    section: 'agent',
    title: 'Shell and transport',
    fields: [
      textField('shellPath', 'Shell executable', undefined, 'file'),
      textField('shellCommandPrefix', 'Shell command prefix'),
      listField(
        'npmCommand',
        'Package manager command',
        'Executable followed by arguments, in order.',
        true
      ),
      choiceField('transport', 'Provider transport', [
        ['auto', 'Automatic'],
        ['sse', 'Server-sent events'],
        ['web-socket', 'WebSocket'],
        ['websocket-cached', 'Cached WebSocket']
      ]),
      booleanField('images.autoResize', 'Resize images automatically'),
      booleanField('images.blockImages', 'Block image input')
    ]
  },
  {
    section: 'resources',
    title: 'Skills and prompt templates',
    fields: [
      booleanField('enableBuiltinSkills', 'Built-in skills'),
      booleanField('bundledSkills.websearch', 'Bundled web search skill'),
      booleanField('enableSkillCommands', 'Skill slash commands'),
      listField('skills', 'Skill paths', 'Additional skill files or directories.'),
      listField(
        'prompts',
        'Prompt template paths',
        'Additional prompt template files or directories.'
      ),
      listField('themes', 'Theme paths', 'Additional theme files or directories.'),
      listField(
        'mcpCatalogSources',
        'MCP catalog sources',
        'Local service-catalog files, merged after the built-in catalog.'
      )
    ]
  },
  {
    section: 'sessions',
    title: 'Session storage',
    fields: [
      textField('sessionDir', 'Session directory', 'Storage directory for new sessions.', 'folder'),
      limitField(
        'idleEvictionMinutes',
        'Unload idle sessions after',
        'off',
        'Minutes before an idle session leaves memory. Saved history remains available.'
      ),
      limitField(
        'sessionArchiveMaxAgeDays',
        'Archive sessions after',
        'off',
        'Archive sessions untouched for this many days.'
      ),
      limitField(
        'sessionArchiveMaxSessions',
        'Maximum unarchived sessions',
        'off',
        'Keep the most recently modified sessions. Zero also disables this rule.'
      )
    ]
  },
  {
    section: 'engine',
    title: 'Updates and diagnostics',
    fields: [
      choiceField('updateChannel', 'Update channel', [
        ['stable', 'Stable'],
        ['nightly', 'Nightly']
      ]),
      booleanField('agentTraces.enabled', 'Agent traces'),
      booleanField(
        'requestTiming',
        'Provider request timing',
        'Record provider timing phases in the diagnostic log.'
      ),
      booleanField('telemetry.enabled', 'Usage telemetry'),
      booleanField(
        'telemetry.localMirror',
        'Local telemetry mirror',
        'Keep an inspectable local copy of telemetry events.'
      ),
      booleanField('telemetry.noticeShown', 'Telemetry notice acknowledged'),
      booleanField('warnings.anthropicExtraUsage', 'Anthropic extra-usage warning')
    ]
  },
  {
    section: 'terminal',
    title: 'Terminal appearance',
    fields: [
      textField('theme', 'Engine theme'),
      choiceField('chatDetail', 'Conversation detail', [
        ['overview', 'Overview'],
        ['details', 'Details'],
        ['all', 'All']
      ]),
      choiceField('treeFilterMode', 'Tree filter mode', [
        ['default', 'Default'],
        ['no-tools', 'Hide tools'],
        ['user-only', 'User messages'],
        ['labeled-only', 'Labeled entries'],
        ['all', 'All entries']
      ]),
      numberField('editorPaddingX', 'Editor horizontal padding'),
      numberField('autocompleteMaxVisible', 'Visible autocomplete results'),
      booleanField('showHardwareCursor', 'Hardware cursor'),
      booleanField('terminal.showImages', 'Show terminal images'),
      booleanField('terminal.clearOnShrink', 'Clear terminal when shrinking'),
      booleanField('terminal.showTerminalProgress', 'Terminal progress indicator'),
      booleanField('terminal.fullscreenMouse', 'Full-screen mouse support'),
      booleanField('quietStartup', 'Quiet startup'),
      textField('markdown.codeBlockIndent', 'Code block indentation'),
      choiceField('markdown.mermaid', 'Mermaid rendering', [
        ['off', 'Off'],
        ['final', 'When complete'],
        ['streaming', 'While streaming']
      ]),
      booleanField('onboardingShown', 'Onboarding shown'),
      booleanField('onboardingCompleted', 'Onboarding completed')
    ]
  }
]
