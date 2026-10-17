import {
  Copy,
  CopyPlus,
  ExternalLink,
  FileDown,
  FileJson,
  FolderSearch,
  GitFork,
  ListTree,
  Pencil,
  Pin,
  PinOff,
  Share2,
  Trash2,
  X
} from 'lucide-react'
import type { SessionListItem } from '@shared/api/sessions'
import { deleteItemCombo } from '../../lib/keybindings'
import { REVEAL_LABEL } from '../../lib/platform-copy'
import { useAgents } from '../../store/agents'
import type { MenuItem } from '../../ui'
import {
  cloneSession,
  exportSession,
  openSession,
  requestCloseAgent,
  revealSession,
  sessionTargetEngine,
  shareSession
} from './actions'
import { itemTitle } from './model'
import { togglePinned, useSessions, type SessionTarget } from './store'

function fileItems(target: SessionTarget): MenuItem[] {
  const path = target.path
  return [
    {
      label: 'Fork from a message…',
      icon: <GitFork />,
      onSelect: () => useSessions.getState().openDialog({ kind: 'fork', target })
    },
    {
      label: 'Clone',
      icon: <CopyPlus />,
      disabled: !path && !target.agentId,
      onSelect: () => void cloneSession(target)
    },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: 'Export',
      icon: <FileDown />,
      items: [
        {
          label: 'Web page (HTML)…',
          icon: <FileDown />,
          onSelect: () => void exportSession(target, 'html')
        },
        {
          label: 'Session file (JSONL)…',
          icon: <FileJson />,
          onSelect: () => void exportSession(target, 'jsonl')
        }
      ]
    },
    {
      label: 'Share…',
      icon: <Share2 />,
      disabled: !path && !target.agentId,
      onSelect: () => shareSession(target)
    },
    { kind: 'separator' },
    {
      label: REVEAL_LABEL,
      icon: <FolderSearch />,
      disabled: !path,
      onSelect: () => path && revealSession(path)
    },
    {
      label: 'Copy file path',
      icon: <Copy />,
      disabled: !path,
      onSelect: () => path && void navigator.clipboard.writeText(path)
    }
  ]
}

function pinItem(path: string | undefined, pinned: boolean): MenuItem {
  return {
    label: pinned ? 'Unpin' : 'Pin',
    icon: pinned ? <PinOff /> : <Pin />,
    disabled: !path,
    onSelect: () => path && togglePinned(path)
  }
}

export function historyMenu(item: SessionListItem, pinned: boolean): MenuItem[] {
  const target: SessionTarget & { path: string } = {
    path: item.path,
    cwd: item.cwd,
    title: itemTitle(item),
    engine: item.engine
  }
  return [
    { label: 'Open', icon: <ExternalLink />, onSelect: () => void openSession(item) },
    {
      label: 'Rename',
      icon: <Pencil />,
      hotkey: 'f2',
      onSelect: () => useSessions.getState().setRenaming(item.path)
    },
    {
      label: 'Browse session tree…',
      icon: <ListTree />,
      onSelect: () => useSessions.getState().openDialog({ kind: 'tree', target })
    },
    pinItem(item.path, pinned),
    { kind: 'separator' },
    ...fileItems(target),
    { kind: 'separator' },
    {
      label: 'Delete…',
      icon: <Trash2 />,
      hotkey: deleteItemCombo(),
      danger: true,
      onSelect: () => useSessions.getState().openDialog({ kind: 'delete', target })
    }
  ]
}

export function openAgentMenu(target: SessionTarget, pinned: boolean): MenuItem[] {
  const agentId = target.agentId!
  const path = target.path
  const agent = useAgents.getState().agents[agentId]
  const keepsRunning = sessionTargetEngine(target) === 'prime' && !agent?.info.args.noSession
  return [
    {
      label: 'Rename',
      icon: <Pencil />,
      hotkey: 'f2',
      onSelect: () => useSessions.getState().setRenaming(`agent:${agentId}`)
    },
    pinItem(path, pinned),
    { kind: 'separator' },
    ...fileItems(target),
    { kind: 'separator' },
    {
      label: keepsRunning ? 'Close tab — keep session running' : 'Close tab',
      icon: <X />,
      onSelect: () => requestCloseAgent(agentId)
    },
    {
      label: 'Delete…',
      icon: <Trash2 />,
      danger: true,
      disabled: !path,
      onSelect: () =>
        path && useSessions.getState().openDialog({ kind: 'delete', target: { ...target, path } })
    }
  ]
}
