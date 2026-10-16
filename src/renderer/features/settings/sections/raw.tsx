import { useEffect, useState } from 'react'
import { FileClock, FileDiff, FolderOpen, RotateCcw } from 'lucide-react'
import type { ValidationIssue } from '@shared/api/settings'
import { invoke } from '../ipc'
import { Button, Dialog, toast } from '../../../ui'
import { afterEngineConfigChange, agentsForEngine } from '../engines'
import { Callout } from '../layout'
import { activeCwd, useSettings } from '../store'
import { IssueList, JsonDiff, JsonEditor, parseJsonText } from './json-editor'

/** Raw settings.json for the active scope: live validation, then a diff review before saving. */
export function RawSection() {
  const engine = useSettings((state) => state.engine)
  const snapshot = useSettings((s) => s.snapshot)
  const scope = useSettings((s) => s.scope)
  const replaceSnapshot = useSettings((s) => s.replaceSnapshot)
  const file = scope === 'project' ? snapshot?.project : snapshot?.global
  const original = file?.text ?? ''
  const [text, setText] = useState(original)
  /** The file text the buffer started from; differs from `original` once the file changed on disk under unsaved edits. */
  const [base, setBase] = useState(original)
  const [synced, setSynced] = useState({ scope, original })
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [review, setReview] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = (fileText: string) => {
    setText(fileText)
    setBase(fileText)
  }
  // A clean buffer follows the file and the scope; unsaved edits stay until the user reloads or keeps them.
  if (synced.scope !== scope || synced.original !== original) {
    setSynced({ scope, original })
    if (synced.scope !== scope || text === base) load(original)
  }

  const parsed = parseJsonText(text)
  const dirty = text !== base
  const changedOnDisk = dirty && base !== original
  useEffect(() => {
    const timer = setTimeout(
      () => void invoke('settings:validate', text, scope).then(setIssues),
      200
    )
    return () => clearTimeout(timer)
  }, [text, scope])

  const errors = issues.filter((i) => i.severity === 'error').length + (parsed.error ? 1 : 0)

  const save = async () => {
    const cwd = activeCwd()
    setSaving(true)
    try {
      const next = await invoke('settings:write-raw', { scope, cwd, text })
      load((scope === 'project' ? next.project?.text : next.global.text) ?? '')
      if (activeCwd() === cwd) replaceSnapshot(next, engine)
      setReview(false)
      toast({ level: 'success', title: 'settings.json saved' })
      const affected =
        scope === 'project' ? { agentIds: agentsForEngine(engine, cwd), patch: {} } : undefined
      afterEngineConfigChange('restart', affected, engine)
    } catch (error) {
      toast({ level: 'error', title: 'Not saved', description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  if (!file) return null
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{file.path}</code>
        {!file.exists && <span className="text-xs text-fg-3">Not created yet</span>}
        {file.exists && (
          <Button
            size="sm"
            variant="ghost"
            leading={<FolderOpen />}
            onClick={() => void invoke('sys:reveal', file.path)}
          >
            Reveal
          </Button>
        )}
      </div>
      {changedOnDisk && (
        <Callout
          tone="info"
          icon={<FileClock />}
          title="Changed on disk"
          action={
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setBase(original)}>
                Keep mine
              </Button>
              <Button size="sm" variant="secondary" onClick={() => load(original)}>
                Reload
              </Button>
            </div>
          }
        >
          settings.json was edited outside Vengeance. Reload it, or keep your edits and review them
          against the new file.
        </Callout>
      )}
      <JsonEditor
        aria-label="settings.json"
        text={text}
        onChange={setText}
        errorLine={parsed.error?.line}
        height={440}
      />
      <IssueList issues={issues} parseError={parsed.error} />
      <div className="mt-4 flex items-center gap-2">
        <span className="flex-1 text-sm text-fg-3">
          {errors > 0
            ? `${errors} ${errors === 1 ? 'error' : 'errors'} — fix before saving.`
            : dirty
              ? 'Unsaved changes.'
              : 'Valid. Unknown keys are kept as-is.'}
        </span>
        <Button
          variant="ghost"
          leading={<RotateCcw />}
          disabled={!dirty}
          onClick={() => load(original)}
        >
          Revert
        </Button>
        <Button
          variant="primary"
          leading={<FileDiff />}
          disabled={!dirty || errors > 0}
          onClick={() => setReview(true)}
        >
          Review & save
        </Button>
      </div>
      <Dialog
        open={review}
        onOpenChange={setReview}
        size="editor"
        icon={<FileDiff />}
        title="Review changes"
        description={`${scope === 'project' ? 'Project' : 'Global'} settings.json`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReview(false)}>
              Keep editing
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        <JsonDiff before={original} after={text} maxHeight={420} />
      </Dialog>
    </>
  )
}
