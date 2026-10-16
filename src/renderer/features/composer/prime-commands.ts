import {
  Activity,
  Blocks,
  Brain,
  Clock,
  FileText,
  Gauge,
  GitBranch,
  Layers,
  MessageSquare,
  Server,
  Settings,
  Sparkles,
  Target,
  Workflow
} from 'lucide-react'
import type { SettingsSectionId } from '@shared/api/settings-schema'
import { useAgents } from '../../store/agents'
import { openPrimeControls } from '../engines/prime-controls'
import { nativeRecord, nativeText, primeCommand } from '../engines/prime-runtime'
import { PRIME_SERVICE_TIERS, PRIME_TRACE_ACTIONS } from '../engines/prime-schema'
import { openPalette } from '../palette/store'
import { openSettingsSection, revealSetting } from '../palette/settings-sections'
import { settingsInvokeForFolder } from '../settings/ipc'
import { toast } from '../../ui'
import type { BuiltinCommand } from './builtins'
import { setThinkingLevel } from './operations'
import { runTokenSpeedCommand } from './token-speed'

type NativeSection = Parameters<typeof openPrimeControls>[1]

function panel(section: NativeSection): BuiltinCommand['run'] {
  return (agentId, text) => openPrimeControls(agentId, section, text)
}

function settings(section: SettingsSectionId, key?: string): BuiltinCommand['run'] {
  return () => {
    if (key) revealSetting(section, key, 'prime')
    else openSettingsSection(section, 'prime')
  }
}

function nativePrompt(command: string, section: NativeSection): BuiltinCommand['run'] {
  return async (agentId, text) => {
    if (!text) return openPrimeControls(agentId, section)
    try {
      await useAgents.getState().prompt(agentId, `/${command} ${text}`)
    } catch (error) {
      toast({
        level: 'error',
        title: `Could not run /${command}`,
        description: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

const SERVICE_TIERS = PRIME_SERVICE_TIERS.map((tier) => tier.value)

async function setServiceTier(agentId: string, serviceTier: string): Promise<void> {
  if (!SERVICE_TIERS.includes(serviceTier)) {
    toast({
      level: 'warning',
      title: `Unknown service tier “${serviceTier}”`,
      description: SERVICE_TIERS.join(', ')
    })
    return
  }
  try {
    await primeCommand(agentId, 'set_service_tier', { serviceTier })
    const state = nativeRecord(await primeCommand(agentId, 'get_state', {}))
    const applied = nativeText(state.serviceTier) || 'default'
    toast({
      level: applied === serviceTier ? 'success' : 'info',
      title: `Service tier: ${applied}`,
      description:
        applied === serviceTier ? undefined : `This model does not support the ${serviceTier} tier.`
    })
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not change service tier',
      description: (error as Error).message
    })
  }
}

async function setSubagentDepth(agentId: string, text: string): Promise<void> {
  if (!text) return openPrimeControls(agentId, 'subagents')
  const match = /^(\d+)(?:\s+(--global))?$/.exec(text)
  const maxDepth = Number(match?.[1])
  if (!match || !Number.isSafeInteger(maxDepth)) {
    toast({ level: 'warning', title: 'Use /rlm-max-depth <non-negative integer> [--global]' })
    return
  }
  try {
    const result = nativeRecord(
      await primeCommand(agentId, 'set_rlm_max_depth', {
        maxDepth,
        global: !!match[2]
      })
    )
    const globalError = nativeText(result.globalError)
    toast({
      level: globalError ? 'warning' : 'success',
      title: `Subagent depth: ${maxDepth}`,
      description:
        globalError ||
        (result.globalSaved === true
          ? 'Also saved as the global default.'
          : 'Applied to this session.')
    })
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not change subagent depth',
      description: (error as Error).message
    })
  }
}

type DeliveryMode = 'steer' | 'follow_up'

function deliveryMode(value: string): DeliveryMode {
  const mode = value.toLowerCase().replace('-', '_')
  if (mode === 'steer' || mode === 'follow_up') return mode
  throw new Error('Heartbeat delivery must be steer or follow_up.')
}

function consumeDelivery(text: string): { rest: string; mode?: DeliveryMode } {
  let rest = text.trim()
  let mode: DeliveryMode | undefined
  while (rest.startsWith('--')) {
    const leading = /^(?:--(steer|follow-up|follow_up)(?=\s|$)|--deliver(?:=|\s+)(\S+))\s*/.exec(
      rest
    )
    if (!leading) break
    mode = deliveryMode(leading[1] ?? leading[2] ?? '')
    rest = rest.slice(leading[0].length).trim()
  }
  let lastMode: DeliveryMode | undefined
  for (;;) {
    const trailing = /\s+(?:--(steer|follow-up|follow_up)|--deliver(?:=|\s+)(\S+))$/i.exec(rest)
    if (!trailing) break
    lastMode ??= deliveryMode(trailing[1] ?? trailing[2] ?? '')
    rest = rest.slice(0, trailing.index).trim()
  }
  if (rest === '--deliver' || rest.endsWith(' --deliver')) {
    throw new Error('Heartbeat delivery must be steer or follow_up.')
  }
  return { rest, mode: lastMode ?? mode }
}

const DEFAULT_HEARTBEAT_SCHEDULE = 'every 5m'
const HEARTBEAT_INTERVAL =
  /^\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i
const HEARTBEAT_USAGE = 'Use /heartbeat [--every <interval>] [--steer|--follow-up] <instruction>.'

function heartbeatArguments(text: string): {
  schedule: string
  prompt: string
  deliveryMode: DeliveryMode
} {
  const leading = consumeDelivery(text)
  let rest = leading.rest
  let schedule = DEFAULT_HEARTBEAT_SCHEDULE
  const option = /^--every(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))\s*/.exec(rest)
  if (option) {
    const interval = (option[1] ?? option[2] ?? option[3] ?? '').trim()
    if (!interval) throw new Error(HEARTBEAT_USAGE)
    schedule = HEARTBEAT_INTERVAL.test(interval) ? `every ${interval}` : interval
    rest = rest.slice(option[0].length).trim()
  } else {
    if (rest === '--every' || rest.startsWith('--every=')) throw new Error(HEARTBEAT_USAGE)
    const inline = /^(every|each)\s+(\S+)\s*/i.exec(rest)
    if (inline && HEARTBEAT_INTERVAL.test(inline[2]!)) {
      schedule = `${inline[1]} ${inline[2]}`
      rest = rest
        .slice(inline[0].length)
        .replace(/^--(?:\s+|$)/, '')
        .trim()
    }
  }
  const trailing = consumeDelivery(rest)
  if (!trailing.rest) throw new Error(HEARTBEAT_USAGE)
  return { schedule, prompt: trailing.rest, deliveryMode: trailing.mode ?? leading.mode ?? 'steer' }
}

async function runHeartbeat(agentId: string, text: string): Promise<void> {
  if (!text || text === 'status') return openPrimeControls(agentId, 'schedule')
  try {
    if (text === 'pause' || text === 'resume' || text === 'stop' || text === 'clear') {
      await primeCommand(agentId, 'heartbeat_update', { action: text })
    } else {
      await primeCommand(agentId, 'heartbeat_set', heartbeatArguments(text))
    }
    openPrimeControls(agentId, 'schedule')
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not update heartbeat',
      description: (error as Error).message
    })
  }
}

async function runFactory(agentId: string, text: string): Promise<void> {
  const action = text.trim().toLowerCase()
  if (!action || action === 'status') return openPrimeControls(agentId, 'factory')
  if (action !== 'on' && action !== 'off') {
    toast({ level: 'warning', title: 'Use /factory on, /factory off or /factory status' })
    return
  }
  const cwd = useAgents.getState().agents[agentId]?.info.cwd
  if (!cwd) return
  try {
    await settingsInvokeForFolder('prime', cwd, 'settings:set', {
      scope: 'global',
      cwd,
      path: ['factory', 'enabled'],
      value: action === 'on'
    })
    toast({
      level: 'success',
      title: `Factory ${action === 'on' ? 'enabled' : 'disabled'}`,
      description: 'The native factory setting applies when the engine session next starts.'
    })
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not change factory mode',
      description: (error as Error).message
    })
  }
}

export const PRIME_COMMANDS: BuiltinCommand[] = [
  {
    name: 'effort',
    description: 'Set the thinking level',
    args: '[level]',
    icon: Brain,
    run: (agentId, text) => {
      if (!text) return openPalette('thinking')
      const levels = useAgents.getState().agents[agentId]?.thinkingLevels ?? []
      const wanted = text.toLowerCase().replace(/^extra[\s-]?high$/, 'xhigh')
      const level = levels.find((candidate) => candidate === wanted)
      if (level) return setThinkingLevel(agentId, level)
      toast({
        level: 'warning',
        title: `Unknown thinking level “${text}”`,
        description: levels.length ? `Available: ${levels.join(', ')}` : undefined
      })
    }
  },
  {
    name: 'goal',
    description: 'Set or manage the session goal and token budget',
    args: '[objective]',
    icon: Target,
    run: nativePrompt('goal', 'goal')
  },
  {
    name: 'autonomous',
    description: 'Configure autonomous continuation',
    args: '[on|off]',
    icon: Workflow,
    run: nativePrompt('autonomous', 'autonomy')
  },
  {
    name: 'refine',
    description: 'Refine the last result with a native follow-up pass',
    args: '[instructions]',
    icon: Sparkles,
    run: nativePrompt('refine', 'refine')
  },
  {
    name: 'heartbeat',
    args: '[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]',
    description: 'Schedule a session follow-up',
    icon: Clock,
    run: runHeartbeat
  },
  {
    name: 'heartbeats',
    description: 'Manage scheduled follow-ups',
    icon: Clock,
    run: panel('schedule')
  },
  {
    name: 'side',
    description: 'Ask a side question',
    args: '[question]',
    icon: MessageSquare,
    run: panel('side-question')
  },
  {
    name: 'btw',
    description: 'Ask a side question',
    args: '[question]',
    icon: MessageSquare,
    run: panel('side-question')
  },
  {
    name: 'tier',
    args: '[default|flex|priority|auto|scale]',
    description: 'Choose the native service tier',
    icon: Gauge,
    run: (agentId, text) =>
      text ? setServiceTier(agentId, text.toLowerCase()) : openPrimeControls(agentId, 'autonomy')
  },
  {
    name: 'context',
    description: 'Inspect context use and the system prompt',
    icon: Layers,
    run: panel('context')
  },
  {
    name: 'usage',
    description: 'Inspect context use and the system prompt',
    icon: Activity,
    run: panel('context')
  },
  {
    name: 'system-prompt',
    description: 'Inspect the session system prompt',
    icon: FileText,
    run: panel('context')
  },
  {
    name: 'subagents',
    description: 'Inspect and control native subagents',
    icon: GitBranch,
    run: panel('subagents')
  },
  {
    name: 'rlm-max-depth',
    args: '[<integer> [--global]]',
    description: 'Configure subagent recursion depth',
    icon: GitBranch,
    run: setSubagentDepth
  },
  {
    name: 'factory',
    args: '[on|off|status]',
    description: 'Inspect and control factory execution',
    icon: Workflow,
    run: runFactory
  },
  { name: 'mcp', description: 'Manage MCP servers', icon: Server, run: settings('mcp') },
  {
    name: 'plugins',
    description: 'Browse and connect external services',
    icon: Blocks,
    run: settings('mcp')
  },
  { name: 'logs', description: 'Open engine diagnostics', icon: FileText, run: settings('engine') },
  {
    name: 'traces',
    args: '[status|on|off|preview|upload|upload-current|upload-all|login]',
    description: 'Preview, upload or configure native session traces',
    icon: Activity,
    run: (agentId, text) => {
      const action = text.trim().toLowerCase()
      if (action && !PRIME_TRACE_ACTIONS.includes(action)) {
        toast({
          level: 'warning',
          title: 'Unknown trace action',
          description: PRIME_TRACE_ACTIONS.join(', ')
        })
        return
      }
      openPrimeControls(agentId, 'traces', action)
    }
  },
  {
    name: 'telemetry',
    description: 'Configure telemetry',
    icon: Activity,
    run: settings('engine', 'telemetry.enabled')
  },
  {
    name: 'speed',
    args: '[on|off]',
    description: 'Toggle output token speed and session average',
    icon: Gauge,
    run: runTokenSpeedCommand
  },
  {
    name: 'update',
    description: 'Review available engine updates',
    icon: Settings,
    run: settings('engine')
  },
  {
    name: 'nightly',
    description: 'Review engine release channels',
    icon: Settings,
    run: settings('engine')
  }
]
