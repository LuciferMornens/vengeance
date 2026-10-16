/**
 * Extension UI (rpc-extension-ui.md): select/confirm/input/editor dialogs for the active agent with
 * timeouts honored, notify → toasts, background-agent requests surfaced as toasts, status chips
 * (`ExtensionStatusChips`) and above/below-editor widgets (`ExtensionWidgets`), both mounted by the composer.
 * The inspector keeps the full status and widget lists; it renders todo-style widgets with
 * `parseChecklist(lines)` + `ChecklistCard({ list, name, className?, docked? })`; lists docked above the composer
 * collapse with `useDockedChecklistCollapsed()`. `StateGlyph({ state })` is the one task-state glyph.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ExtensionErrorEvent, RpcExtensionUIResponse } from '@shared/engine-types'
import type { PendingDialog } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { toast, useToasts } from '../../ui'
import { childSessionTitle } from '../sessions/model'
import { ConfirmDialog, EditorDialog, InputDialog, SelectDialog, type DialogAnswer } from './dialogs'
import { extensionErrorText, splitNotifyMessage } from './toast-text'

export { ExtensionStatusChips } from './StatusChips'
export { ChecklistCard, StateGlyph, useDockedChecklistCollapsed } from './ChecklistCard'
export { aboveEditorCard, ExtensionWidgets, useChecklistWidgetKeys } from './Widgets'
export { parseChecklist, type Checklist, type ChecklistItem, type ChecklistState } from './checklist'
export { formatLspStatus, LSP_STATUS_KEY } from './lsp-status'

function deadlineOf(dialog: PendingDialog): number | null {
  const { request } = dialog
  return request.method !== 'editor' && request.timeout ? dialog.receivedAt + request.timeout : null
}

function sessionLabel(agentId: string): string {
  const agent = useAgents.getState().agents[agentId]
  const name = agent?.sessionName && (childSessionTitle(agent.sessionName, undefined) ?? agent.sessionName)
  return agent?.ext.title ?? (name || 'A background session')
}

/** Remove a dialog locally (pi already resolved it with its default value). */
function dropDialog(agentId: string, id: string): void {
  const agent = useAgents.getState().agents[agentId]
  if (!agent || !agent.ext.dialogs.some((d) => d.request.id === id)) return
  useAgents.getState().patchAgent(agentId, { ext: { ...agent.ext, dialogs: agent.ext.dialogs.filter((d) => d.request.id !== id) } })
}

/** The session's extension errors in the inspector (switching to the session first). */
function showExtensionErrors(agentId: string): void {
  useAgents.getState().setActive(agentId)
  useApp.getState().setInspectorTab('extensions')
}

/**
 * Toasts for notify requests, extension failures (a throwing command or event handler; the same failure again
 * stays quiet) and dialogs that arrive in a session the user is not looking at.
 */
function useExtensionToasts(): void {
  const seen = useRef(new Set<string>())
  const seenErrors = useRef(new WeakSet<ExtensionErrorEvent>())
  useEffect(() => {
    const announce = (state: ReturnType<typeof useAgents.getState>) => {
      for (const agent of Object.values(state.agents)) {
        const background = agent.id !== state.activeAgentId
        for (const n of agent.ext.notifications) {
          if (seen.current.has(n.id)) continue
          seen.current.add(n.id)
          const text = splitNotifyMessage(n.message)
          const description = [text.description, background ? sessionLabel(agent.id) : undefined].filter(Boolean).join('\n')
          toast({ level: n.level, title: text.title, description: description || undefined })
        }
        for (const error of agent.extensionErrors) {
          if (seenErrors.current.has(error)) continue
          seenErrors.current.add(error)
          const key = `error:${agent.id}\u0000${error.extensionPath}\u0000${error.event}\u0000${error.error}`
          if (seen.current.has(key)) continue
          seen.current.add(key)
          toast({ level: 'warning', ...extensionErrorText(error), duration: 7000, action: { label: 'Details', onClick: () => showExtensionErrors(agent.id) } })
        }
        for (const dialog of agent.ext.dialogs) {
          if (seen.current.has(dialog.request.id)) continue
          seen.current.add(dialog.request.id)
          if (!background) continue
          toast({
            id: `dialog-${dialog.request.id}`,
            level: 'warning',
            title: `${sessionLabel(agent.id)} needs your input`,
            description: dialog.request.title,
            duration: 0,
            action: { label: 'Open session', onClick: () => useAgents.getState().setActive(agent.id) }
          })
        }
      }
    }
    announce(useAgents.getState())
    return useAgents.subscribe(announce)
  }, [])
}

function timedDialogs(): Array<{ agentId: string; id: string; at: number }> {
  return Object.values(useAgents.getState().agents).flatMap((agent) =>
    agent.ext.dialogs.flatMap((dialog) => {
      const at = deadlineOf(dialog)
      return at === null ? [] : [{ agentId: agent.id, id: dialog.request.id, at }]
    })
  )
}

/** Drop expired dialogs (receivedAt + timeout) for every agent, not just the visible one. */
function useDialogExpiry(): void {
  const key = useAgents((s) =>
    Object.values(s.agents)
      .flatMap((agent) => agent.ext.dialogs.map((d) => `${d.request.id}@${deadlineOf(d) ?? ''}`))
      .join('|')
  )
  useEffect(() => {
    const timers = timedDialogs().map((t) =>
      setTimeout(
        () => {
          dropDialog(t.agentId, t.id)
          toast({ level: 'info', title: 'Request timed out', description: 'The extension continued with its default answer.', duration: 3200 })
        },
        Math.max(0, t.at - Date.now())
      )
    )
    return () => timers.forEach(clearTimeout)
  }, [key])
}

function ActiveDialog({ agentId, dialog, index, total, open }: { agentId: string; dialog: PendingDialog; index: number; total: number; open: boolean }) {
  const answered = useRef(false)
  const answer = useMemo<DialogAnswer>(() => {
    const respond = (response: RpcExtensionUIResponse) => {
      if (answered.current) return
      answered.current = true
      void useAgents
        .getState()
        .respondUi(agentId, response)
        .catch((error: Error) => toast({ level: 'error', title: 'Could not answer the extension', description: error.message }))
    }
    const id = dialog.request.id
    return {
      value: (value) => respond({ type: 'extension_ui_response', id, value }),
      confirm: (confirmed) => respond({ type: 'extension_ui_response', id, confirmed }),
      cancel: () => respond({ type: 'extension_ui_response', id, cancelled: true })
    }
  }, [agentId, dialog.request.id])

  const deadline = deadlineOf(dialog)
  const frame = {
    open,
    position: { index, total },
    deadline: deadline !== null && dialog.request.method !== 'editor' && dialog.request.timeout ? { at: deadline, total: dialog.request.timeout } : undefined
  }
  const { request } = dialog
  switch (request.method) {
    case 'select':
      return <SelectDialog request={request} answer={answer} frame={frame} />
    case 'confirm':
      return <ConfirmDialog request={request} answer={answer} frame={frame} />
    case 'input':
      return <InputDialog request={request} answer={answer} frame={frame} />
    case 'editor':
      return <EditorDialog request={request} answer={answer} frame={frame} />
  }
}

/** How long an answered dialog stays mounted (closed) so its exit animation can play. */
const EXIT_MS = 180

interface ShownDialog {
  agentId: string
  dialog: PendingDialog
  total: number
}

/** Mount once at the app root. */
export function ExtensionUiHost() {
  const activeId = useAgents((s) => s.activeAgentId)
  const dialogs = useAgents((s) => (activeId ? s.agents[activeId]?.ext.dialogs : undefined))
  const [closing, setClosing] = useState<ShownDialog | null>(null)
  const shown = useRef<ShownDialog | null>(null)
  useExtensionToasts()
  useDialogExpiry()

  // A session the user switched to no longer needs its "needs your input" toast.
  useEffect(() => {
    if (!activeId) return
    for (const dialog of useAgents.getState().agents[activeId]?.ext.dialogs ?? []) useToasts.getState().dismiss(`dialog-${dialog.request.id}`)
  }, [activeId])

  const dialog = dialogs?.[0]
  const current = activeId && dialog ? { agentId: activeId, dialog, total: dialogs.length } : null

  // Keep the answered dialog rendered (closed) for its exit animation.
  const currentId = current?.dialog.request.id
  useEffect(() => {
    const previous = shown.current
    shown.current = currentId ? { agentId: activeId!, dialog: dialog!, total: dialogs!.length } : null
    if (!currentId && previous) setClosing(previous)
  }, [currentId, activeId, dialog, dialogs])
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(null), EXIT_MS)
    return () => clearTimeout(timer)
  }, [closing])

  const view = current ?? closing
  if (!view) return null
  return <ActiveDialog key={view.dialog.request.id} agentId={view.agentId} dialog={view.dialog} index={1} total={view.total} open={view === current} />
}
