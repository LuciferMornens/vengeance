import { Rocket, ShieldQuestion, SlidersHorizontal } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { samePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import { useApp, workspaceEngine } from '../../store/app'
import { engineDescriptor } from '../engines/registry'
import { manageWorkspaceTrust } from './spawn'
import { openLaunchDialog } from './store'

const activeWorkspace = () => useApp.getState().prefs.activeWorkspace

function workspaceSupportsTrust(): boolean {
  const cwd = activeWorkspace()
  if (!cwd) return false
  const agents = useAgents.getState()
  const active = agents.activeAgentId ? agents.agents[agents.activeAgentId] : undefined
  const engine =
    active && samePath(active.info.cwd, cwd) ? active.info.engine : workspaceEngine(cwd)
  return engineDescriptor(engine)?.capabilities.trust ?? engine === 'pi'
}

/** Palette actions; `workspace.trust` is also the target of the `/trust` built-in. */
export function registerLaunchActions(): () => void {
  return registerActions([
    {
      id: 'session.newWithOptions',
      title: 'New session with options…',
      group: 'General',
      keywords: ['launch', 'tools', 'flags', 'system prompt', 'offline', 'environment'],
      icon: Rocket,
      when: () => !!activeWorkspace(),
      run: () => {
        const cwd = activeWorkspace()
        if (cwd) openLaunchDialog('session', cwd)
      }
    },
    {
      id: 'workspace.launchOptions',
      title: 'Workspace launch options…',
      group: 'General',
      keywords: ['launch', 'defaults', 'tools', 'extension flags', 'environment', 'system prompt'],
      icon: SlidersHorizontal,
      when: () => !!activeWorkspace(),
      run: () => {
        const cwd = activeWorkspace()
        if (cwd) openLaunchDialog('workspace', cwd)
      }
    },
    {
      id: 'workspace.trust',
      title: 'Project trust…',
      group: 'General',
      keywords: ['trust', 'approve', 'security', '/trust'],
      icon: ShieldQuestion,
      when: workspaceSupportsTrust,
      run: () => {
        const cwd = activeWorkspace()
        if (cwd) void manageWorkspaceTrust(cwd)
      }
    }
  ])
}
