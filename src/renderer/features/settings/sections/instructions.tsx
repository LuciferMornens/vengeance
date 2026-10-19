import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, FilePlus2, FileText, RotateCcw } from 'lucide-react'
import type { InstructionFileKind, InstructionFileState, SettingsScope } from '@shared/api/settings'
import { ENGINE_LABELS } from '@shared/api/engine'
import { useApp } from '../../../store/app'
import { Badge, Button, Skeleton } from '../../../ui'
import { settingsInvokeForFolder, on } from '../ipc'
import { Callout, Group, Row } from '../layout'
import { useSettings } from '../store'
import { InstructionEditor, type InstructionEditorTarget } from './instruction-editor'
import { SystemPromptRows } from './system-prompt-viewer'

const INSTRUCTION_KINDS: Array<{
  kind: InstructionFileKind
  title: string
  description: string
}> = [
  {
    kind: 'APPEND_SYSTEM.md',
    title: 'Additional instructions',
    description: 'Add your rules to the engine’s prompt with APPEND_SYSTEM.md.'
  },
  {
    kind: 'SYSTEM.md',
    title: 'Custom foundation',
    description: 'Replace the built-in foundation with SYSTEM.md. Context and skills still apply.'
  },
  {
    kind: 'AGENTS.md',
    title: 'Project guidance',
    description: 'AGENTS.md or CLAUDE.md: conventions and guidance loaded as project context.'
  }
]

const SCOPE_LABEL: Record<SettingsScope, string> = { global: 'Global', project: 'Project' }

export function InstructionsGroup() {
  const engine = useSettings((state) => state.engine)
  const scope = useSettings((state) => state.scope)
  const project = useSettings((state) => state.snapshot?.project)
  const cwd = useApp((state) => state.prefs.activeWorkspace)
  const [files, setFiles] = useState<Record<string, InstructionFileState>>({})
  const [editing, setEditing] = useState<InstructionEditorTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const loadRevision = useRef(0)
  const hasProject = !!project
  const scopes: SettingsScope[] = hasProject ? ['global', 'project'] : ['global']

  const load = useCallback(async () => {
    const revision = ++loadRevision.current
    const references = INSTRUCTION_KINDS.flatMap(({ kind }) =>
      (hasProject ? (['global', 'project'] as const) : (['global'] as const)).map((fileScope) => ({
        kind,
        scope: fileScope
      }))
    )
    try {
      const states = await Promise.all(
        references.map((reference) =>
          settingsInvokeForFolder(engine, cwd, 'settings:instruction-file', cwd, reference)
        )
      )
      if (loadRevision.current !== revision) return
      setFiles(Object.fromEntries(states.map((file) => [`${file.scope}:${file.kind}`, file])))
      setError(null)
    } catch (failure) {
      if (loadRevision.current === revision)
        setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (loadRevision.current === revision) setLoading(false)
    }
  }, [engine, cwd, hasProject])

  useEffect(() => {
    setLoading(true)
    setFiles({})
    setEditing(null)
    void load()
    const unsubscribe = on('settings:changed', (event) => {
      if ((event.engine ?? 'pi') !== engine || event.area !== 'instructions') return
      if (event.project && event.project.cwd !== cwd) return
      void load()
    })
    return () => {
      loadRevision.current++
      unsubscribe()
    }
  }, [load, engine, cwd])

  const customize = (text: string) => {
    const file = files[`${hasProject ? scope : 'global'}:SYSTEM.md`]
    if (file) setEditing({ engine, cwd, file, initialText: text })
  }

  return (
    <Group
      title="System prompt & instructions"
      description={`Inspect ${ENGINE_LABELS[engine]}’s prompt and shape the guidance new sessions use.`}
    >
      <SystemPromptRows
        key={`${engine}:${cwd}`}
        onCustomize={customize}
        canCustomize={!loading && !error}
      />
      {error && (
        <div className="p-4">
          <Callout tone="danger" icon={<AlertCircle />} title="Instruction files unavailable">
            {error}
          </Callout>
          <Button size="sm" variant="ghost" leading={<RotateCcw />} onClick={() => void load()}>
            Reload instruction files
          </Button>
        </div>
      )}
      {INSTRUCTION_KINDS.map(({ kind, title, description }) => (
        <Row
          key={kind}
          settingKey={`instructions.${kind}`}
          label={title}
          description={description}
          badges={
            kind === 'SYSTEM.md' &&
            !loading &&
            !error && (
              <Badge>
                {files[`project:${kind}`]?.exists &&
                (engine === 'prime' || project?.trust.effective)
                  ? 'Project replacement'
                  : files[`global:${kind}`]?.exists
                    ? 'Global replacement'
                    : 'Engine default'}
              </Badge>
            )
          }
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {scopes.map((fileScope) => {
              const file = files[`${fileScope}:${kind}`]
              return loading ? (
                <Skeleton key={fileScope} className="h-7 w-20" />
              ) : (
                <Button
                  key={fileScope}
                  size="sm"
                  variant={file?.exists ? 'secondary' : 'ghost'}
                  leading={file?.exists ? <FileText /> : <FilePlus2 />}
                  disabled={!file}
                  onClick={() => file && setEditing({ engine, cwd, file })}
                >
                  {SCOPE_LABEL[fileScope]}
                </Button>
              )
            })}
          </div>
        </Row>
      ))}
      <div className="border-t border-hairline-soft px-4 py-3 text-xs leading-relaxed text-fg-3">
        Project prompt files take precedence over global files of the same name; they are not
        combined.
        {engine === 'pi' && ' Project prompt files load only in trusted projects.'} Saving never
        restarts an open session. Use an explicit restart when you are ready to apply changes.
      </div>
      {editing && (
        <InstructionEditor
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </Group>
  )
}
