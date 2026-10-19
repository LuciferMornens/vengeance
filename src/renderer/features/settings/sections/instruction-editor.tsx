import { useState } from 'react'
import { AlertCircle, AlertTriangle, FileText, RotateCcw } from 'lucide-react'
import { ENGINE_LABELS, type EngineId } from '@shared/api/engine'
import type { InstructionFileState } from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import { TRASH_NAME } from '../../../lib/platform-copy'
import { Button, Dialog, Badge, toast } from '../../../ui'
import { FOCUS_RING } from '../controls'
import { settingsInvokeForFolder } from '../ipc'
import { Callout } from '../layout'

export interface InstructionEditorTarget {
  engine: EngineId
  cwd: string | null
  file: InstructionFileState
  initialText?: string
}

export function InstructionEditor({
  target,
  onClose,
  onSaved
}: {
  target: InstructionEditorTarget
  onClose: () => void
  onSaved: () => void
}) {
  const { engine, cwd, file } = target
  const [text, setText] = useState(target.initialText ?? file.text)
  const [saving, setSaving] = useState(false)
  const [confirmation, setConfirmation] = useState<'discard' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirty = text !== file.text
  const replacement = file.kind === 'SYSTEM.md'
  const invalid = replacement && !text.trim()
  const resetLabel = replacement
    ? file.scope === 'global'
      ? 'Restore engine default'
      : 'Use global or engine default'
    : 'Remove file'

  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmation('discard')
    else onClose()
  }

  const save = async (next: string | null) => {
    setSaving(true)
    setError(null)
    try {
      await settingsInvokeForFolder(
        engine,
        cwd,
        'settings:instruction-file-write',
        cwd,
        { kind: file.kind, scope: file.scope, expected: { exists: file.exists, text: file.text } },
        next
      )
      toast({
        level: 'success',
        title: next === null ? `${file.kind} removed` : `${file.kind} saved`,
        description: 'New sessions use the saved files. Open sessions keep their current prompt.'
      })
      onSaved()
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setConfirmation(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      persistent
      size="editor"
      icon={<FileText />}
      title={`${file.kind} · ${file.scope === 'global' ? 'Global' : 'Project'}`}
      description={`${ENGINE_LABELS[engine]} · ${replacement ? 'Custom system prompt foundation' : 'Session instructions'}`}
      onOpenChange={(open) => !open && requestClose()}
      hint={confirmation ? undefined : { combo: 'mod+enter', label: 'to save' }}
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key === 'Enter' &&
          !saving &&
          !invalid &&
          !confirmation &&
          (dirty || !file.exists)
        ) {
          event.preventDefault()
          void save(text)
        }
      }}
      footerStart={
        file.exists && !confirmation ? (
          <Button
            size="sm"
            variant="ghost"
            leading={<RotateCcw />}
            disabled={saving}
            onClick={() => setConfirmation('reset')}
          >
            {resetLabel}
          </Button>
        ) : undefined
      }
      footer={
        confirmation ? (
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setConfirmation(null)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              loading={saving}
              onClick={() => (confirmation === 'discard' ? onClose() : void save(null))}
            >
              {confirmation === 'discard'
                ? 'Discard changes'
                : replacement
                  ? 'Remove and restore'
                  : 'Remove file'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={saving} onClick={requestClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={invalid || (!dirty && file.exists)}
              onClick={() => void save(text)}
            >
              {file.exists ? 'Save' : 'Create'}
            </Button>
          </>
        )
      }
    >
      <div className="mb-3 flex items-start gap-3 text-sm leading-relaxed text-fg-2">
        <p className="min-w-0 flex-1">
          {replacement
            ? 'This replaces the built-in foundation. The engine still adds context, skills and session details.'
            : file.kind === 'APPEND_SYSTEM.md'
              ? 'These rules extend the system prompt. A project file takes precedence over the global file.'
              : 'Write the conventions and working guidance the engine should use as project context.'}
        </p>
        {dirty && <Badge>Unsaved</Badge>}
      </div>
      <div title={file.path} className="mb-3 truncate font-mono text-xs leading-relaxed text-fg-3">
        {file.path}
      </div>
      {confirmation && (
        <div className="mb-3" role="alert">
          <Callout
            tone="warning"
            icon={<AlertTriangle />}
            title={
              confirmation === 'discard'
                ? 'Discard changes?'
                : replacement
                  ? 'Restore inherited instructions?'
                  : 'Remove instruction file?'
            }
          >
            {confirmation === 'discard'
              ? 'Discard your unsaved changes? The saved file will stay as it is.'
              : !replacement
                ? `Move ${file.kind} to the ${TRASH_NAME}? Other discovered instruction files and launch-time instructions still apply.`
                : `Move ${file.kind} to the ${TRASH_NAME}? ${
                    file.scope === 'project'
                      ? 'New sessions inherit the global file when it exists, otherwise the engine default.'
                      : 'New sessions use the engine default unless a project file overrides it.'
                  }`}
          </Callout>
        </div>
      )}
      {error && (
        <div className="mb-3" role="alert">
          <Callout tone="danger" icon={<AlertCircle />} title="Could not save">
            {error}
          </Callout>
        </div>
      )}
      <textarea
        aria-label={file.kind}
        value={text}
        disabled={saving}
        spellCheck={false}
        placeholder={
          replacement
            ? 'Write a complete foundation, or customize the built-in prompt…'
            : 'Add your working guidance…'
        }
        onChange={(event) => setText(event.target.value)}
        className={cn(
          'selectable w-full resize-none rounded-md bg-surface-1 px-4 py-3 font-mono text-sm leading-relaxed text-fg placeholder:text-fg-3',
          confirmation || error ? 'h-[min(260px,28vh)]' : 'h-[min(320px,35vh)]',
          'shadow-elev-0 outline-none',
          FOCUS_RING
        )}
      />
      <p className="mt-2 text-xs leading-relaxed text-fg-3">
        {invalid
          ? 'Enter a foundation or restore the inherited prompt.'
          : 'Saved for new sessions. Applying to open work requires an explicit restart.'}
      </p>
    </Dialog>
  )
}
