import { FolderOpen, Info, PanelLeft, PanelRight, Settings, Square, SquarePen } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { openAbout } from '../about'
import { stopAgent } from '../composer/operations'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { chooseWorkspace, newSession } from './workspace'

/** Shell-owned palette actions. Feature lanes register their own from their feature folder. */
export function registerCoreActions(): () => void {
  const app = useApp.getState
  return registerActions([
    {
      id: 'session.new',
      title: 'New session',
      group: 'General',
      hotkey: 'mod+n',
      icon: SquarePen,
      run: () => void newSession()
    },
    {
      id: 'workspace.open',
      title: 'Open folder…',
      group: 'General',
      keywords: ['workspace', 'project'],
      icon: FolderOpen,
      run: () => void chooseWorkspace()
    },
    {
      id: 'settings.open',
      title: 'Open settings',
      group: 'General',
      hotkey: 'mod+comma',
      icon: Settings,
      run: () => app().openSettings()
    },
    {
      id: 'sidebar.toggle',
      title: 'Toggle sidebar',
      group: 'View',
      hotkey: 'mod+b',
      icon: PanelLeft,
      run: () => app().toggleSidebar()
    },
    {
      id: 'inspector.toggle',
      title: 'Toggle inspector',
      group: 'View',
      hotkey: 'mod+i',
      icon: PanelRight,
      run: () => app().toggleInspector()
    },
    {
      id: 'app.about',
      title: 'About Vengeance',
      group: 'General',
      keywords: ['version', 'engine'],
      icon: Info,
      run: openAbout
    },
    {
      id: 'session.abort',
      title: 'Stop the agent',
      group: 'Session',
      icon: Square,
      when: () => {
        const { activeAgentId, agents } = useAgents.getState()
        const agent = activeAgentId ? agents[activeAgentId] : undefined
        return (
          !!agent &&
          (agent.phase === 'running' ||
            !!agent.compaction ||
            Object.values(agent.bash).some((run) => run.running))
        )
      },
      run: () => {
        const agentId = useAgents.getState().activeAgentId
        if (agentId) void stopAgent(agentId)
      }
    }
  ])
}
