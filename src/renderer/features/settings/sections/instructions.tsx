import { useCallback, useEffect, useState } from 'react'
import { FilePlus2, FileText, Trash2 } from 'lucide-react'
import type {
  InstructionFileKind,
  InstructionFileRef,
  InstructionFileState,
  SettingsScope
} from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import { invoke, on } from '../ipc'
import { Button, Dialog, toast } from '../../../ui'
import { FOCUS_RING } from '../controls'
import { Group, Row } from '../layout'
import { activeCwd, useSettings } from '../store'

/** Create and edit AGENTS.md, SYSTEM.md and APPEND_SYSTEM.md (global agent dir or the open project). */

const KINDS: Array<{ kind: InstructionFileKind; title: string; description: string }> = [
  {
    kind: 'AGENTS.md',
    title: 'Instructions',
    description: 'AGENTS.md: guidance loaded into every session, globally or for this project.'
  },
  {
    kind: 'APPEND_SYSTEM.md',
    title: 'Append to system prompt',
    description: 'APPEND_SYSTEM.md: extra rules added after the engine’s system prompt.'
  },
  {
    kind: 'SYSTEM.md',
    title: 'Replace system prompt',
    description: 'SYSTEM.md: replaces the engine’s default system prompt entirely. Use with care.'
  }
]

const SCOPE_LABEL: Record<SettingsScope, string> = { global: 'Global', project: 'Project' }

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function InstructionEditor({
  target,
  onClose,
  onSaved
}: {
  target: InstructionFileState | null
  onClose: () => void
  onSaved: () => void
}) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => setText(target?.text ?? ''), [target])
  const save = async (next: string | null) => {
    if (!target) return
    setSaving(true)
    try {
      await invoke(
        'settings:instruction-file-write',
        activeCwd(),
        { kind: target.kind, scope: target.scope },
        next
      )
      toast({
        level: 'success',
        title:
          next === null
            ? `${fileName(target.path)} moved to the Recycle Bin`
            : `${fileName(target.path)} saved`,
        description: 'New sessions use it right away.'
      })
      onSaved()
      onClose()
    } catch (error) {
      toast({ level: 'error', title: 'Not saved', description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }
  const dirty = !!target && text !== target.text
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      width={720}
      title={target ? `${fileName(target.path)} · ${SCOPE_LABEL[target.scope]}` : ''}
      description={target && <span className="font-mono text-xs text-fg-3">{target.path}</span>}
      footer={
        <>
          {target?.exists && (
            <Button
              variant="ghost"
              leading={<Trash2 />}
              className="mr-auto text-fg-3"
              disabled={saving}
              onClick={() => void save(null)}
            >
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!dirty && target?.exists}
            onClick={() => void save(text)}
          >
            {target?.exists ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <textarea
        aria-label={target ? fileName(target.path) : 'Instructions'}
        value={text}
        spellCheck={false}
        placeholder={
          target?.kind === 'SYSTEM.md'
            ? 'You are a careful senior engineer…'
            : '# Project notes\n\n- Run the tests before committing.'
        }
        onChange={(e) => setText(e.target.value)}
        className={cn(
          'selectable h-[380px] w-full resize-none rounded-card bg-surface-1 px-4 py-3 font-mono text-[12.5px] leading-[1.65] text-fg placeholder:text-fg-3',
          'shadow-[inset_0_0_0_1px_var(--hairline)] outline-none',
          FOCUS_RING
        )}
      />
    </Dialog>
  )
}

export function InstructionsGroup() {
  const hasProject = useSettings((s) => !!s.snapshot?.project)
  const [files, setFiles] = useState<Record<string, InstructionFileState>>({})
  const [editing, setEditing] = useState<InstructionFileState | null>(null)
  const scopes: SettingsScope[] = hasProject ? ['global', 'project'] : ['global']

  const load = useCallback(async () => {
    const refs: InstructionFileRef[] = KINDS.flatMap(({ kind }) =>
      (['global', 'project'] as const).map((scope) => ({ kind, scope }))
    )
    const states = await Promise.all(
      refs.map((ref) =>
        ref.scope === 'project' && !hasProject
          ? null
          : invoke('settings:instruction-file', activeCwd(), ref).catch(() => null)
      )
    )
    setFiles(
      Object.fromEntries(
        states
          .filter((s): s is InstructionFileState => s !== null)
          .map((s) => [`${s.scope}:${s.kind}`, s])
      )
    )
  }, [hasProject])
  useEffect(() => {
    void load()
    return on('settings:changed', ({ area }) => {
      if (area === 'instructions') void load()
    })
  }, [load])

  return (
    <Group
      title="System prompt & instructions"
      description="Plain Markdown files the engine reads when a session starts."
    >
      {KINDS.map(({ kind, title, description }) => (
        <Row key={kind} settingKey={`instructions.${kind}`} label={title} description={description}>
          <div className="flex items-center gap-1.5">
            {scopes.map((scope) => {
              const file = files[`${scope}:${kind}`]
              return (
                <Button
                  key={scope}
                  size="sm"
                  variant={file?.exists ? 'secondary' : 'ghost'}
                  leading={file?.exists ? <FileText /> : <FilePlus2 />}
                  disabled={!file}
                  onClick={() => file && setEditing(file)}
                >
                  {SCOPE_LABEL[scope]}
                </Button>
              )
            })}
          </div>
        </Row>
      ))}
      <InstructionEditor
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
    </Group>
  )
}
