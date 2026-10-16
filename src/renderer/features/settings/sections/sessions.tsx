import { useCallback, useEffect, useState } from 'react'
import {
  FileText,
  FolderOpen,
  MoreHorizontal,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
  Trash2
} from 'lucide-react'
import type { ContextOverview, TrustEntry } from '@shared/api/settings'
import type { EngineId } from '@shared/api/engine'
import { invoke, on } from '../ipc'
import { Badge, Button, DropdownMenu, IconButton, Skeleton, toast } from '../../../ui'
import { afterEngineConfigChange, agentsForEngine } from '../engines'
import { SchemaGroups } from '../fields'
import { Group, Note, Row } from '../layout'
import { activeCwd, useSettings } from '../store'
import { InstructionsGroup } from './instructions'

/** Session storage, project trust and the context files the engine loads into every prompt. */

/**
 * After a trust decision saved in Settings: the folder's open sessions follow it after a restart (restart policy). The
 * restart drops a pinned `--approve`/`--no-approve` so the engine reads the decision just saved.
 */
export function afterTrustChange(folder: string, engine: EngineId = 'pi'): void {
  afterEngineConfigChange(
    'restart',
    { agentIds: agentsForEngine(engine, folder), patch: { approve: undefined } },
    engine
  )
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function TrustGroup() {
  const project = useSettings((s) => s.snapshot?.project)
  const replaceSnapshot = useSettings((s) => s.replaceSnapshot)
  if (!project) return null
  const { trust } = project
  const decide = async (decision: boolean | null) => {
    try {
      replaceSnapshot(await invoke('settings:set-trust', project.cwd, decision), 'pi')
      afterTrustChange(project.cwd)
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not save trust decision',
        description: (error as Error).message
      })
    }
  }
  const Icon = trust.effective ? ShieldCheck : trust.saved === false ? ShieldAlert : ShieldQuestion
  return (
    <Group title="This project">
      <Row
        settingKey="projectTrust"
        label={
          <span className="flex items-center gap-2">
            <Icon className={trust.effective ? 'size-4 text-success' : 'size-4 text-warning'} />
            {trust.effective ? 'Trusted' : 'Not trusted'}
          </span>
        }
        badges={trust.saved === null ? <Badge>Using default</Badge> : undefined}
        description={
          trust.effective
            ? 'Project settings, extensions, skills and MCP servers from this folder load in new sessions.'
            : 'Project settings, extensions and skills from this folder are ignored. Trust it to load them.'
        }
      >
        <div className="flex items-center gap-1.5">
          {trust.saved !== null && (
            <Button size="sm" variant="ghost" onClick={() => void decide(null)}>
              Forget
            </Button>
          )}
          {trust.effective ? (
            <Button size="sm" variant="secondary" onClick={() => void decide(false)}>
              Distrust
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void decide(true)}>
              Trust folder
            </Button>
          )}
        </div>
      </Row>
    </Group>
  )
}

export function ContextGroup() {
  const [overview, setOverview] = useState<ContextOverview | null>(null)
  useEffect(() => {
    const load = () => void invoke('settings:context', activeCwd()).then(setOverview)
    load()
    return on(
      'settings:changed',
      ({ area }) => (area === 'settings' || area === 'instructions') && load()
    )
  }, [])
  const open = (path: string) =>
    void invoke('settings:open-path', path).catch((error: Error) =>
      toast({ level: 'error', title: 'Could not open file', description: error.message })
    )
  if (!overview) {
    return (
      <Group title="Context files">
        <div className="space-y-2 p-4">
          <Skeleton className="h-3.5 w-64" />
          <Skeleton className="h-3.5 w-48" />
        </div>
      </Group>
    )
  }
  const files = [
    ...overview.contextFiles.map((f) => ({ ...f, kind: 'context' as const })),
    ...overview.systemFiles.map((f) => ({ path: f.path, bytes: undefined, kind: f.kind }))
  ]
  return (
    <Group
      title="Loaded context files"
      description="What a new session in this folder reads, in this order."
    >
      {files.length === 0 && (
        <Note icon={<FileText />}>
          No AGENTS.md or CLAUDE.md found for this folder or its parents.
        </Note>
      )}
      {files.map((file) => (
        <Row
          key={file.path}
          label={
            <span className="flex min-w-0 items-center gap-2">
              <FileText className="size-4 shrink-0 text-fg-3" />
              <span className="truncate font-mono text-sm">
                {file.path.split(/[\\/]/).slice(-2).join('/')}
              </span>
            </span>
          }
          badges={file.kind !== 'context' ? <Badge>{file.kind}</Badge> : undefined}
          description={
            <span className="ml-6 block truncate font-mono text-xs text-fg-3">
              {file.path}
              {file.bytes !== undefined && ` · ${formatSize(file.bytes)}`}
            </span>
          }
        >
          <Button size="sm" variant="ghost" onClick={() => open(file.path)}>
            Open
          </Button>
        </Row>
      ))}
    </Group>
  )
}

/** Every saved decision in trust.json: flip or forget them (pi applies a decision to subfolders too). */
function SavedTrustGroup() {
  const [entries, setEntries] = useState<TrustEntry[] | null>(null)
  const load = useCallback(
    () => void invoke('settings:trust-list').then(setEntries, () => setEntries([])),
    []
  )
  useEffect(() => {
    load()
    return on('settings:changed', ({ area }) => area === 'trust' && load())
  }, [load])
  const decide = async (path: string, decision: boolean | null) => {
    try {
      setEntries(await invoke('settings:trust-entry', path, decision))
      void useSettings.getState().load()
      afterTrustChange(path)
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not change trust',
        description: (error as Error).message
      })
    }
  }
  if (!entries) return null
  return (
    <Group
      title="Saved trust decisions"
      description="Folders you trusted or distrusted. A decision also covers every folder inside it."
    >
      {entries.length === 0 && (
        <Note icon={<ShieldQuestion />}>
          No saved decisions yet. New folders follow the default below.
        </Note>
      )}
      {entries.map((entry) => (
        <Row
          key={entry.path}
          settingKey={`trust.${entry.path}`}
          label={
            <span className="flex min-w-0 items-center gap-2">
              {entry.decision ? (
                <ShieldCheck className="size-4 shrink-0 text-success" />
              ) : (
                <ShieldOff className="size-4 shrink-0 text-warning" />
              )}
              <span className="truncate font-mono text-sm">{entry.path}</span>
            </span>
          }
          badges={
            entry.decision ? (
              <Badge tone="success">Trusted</Badge>
            ) : (
              <Badge tone="warning">Not trusted</Badge>
            )
          }
        >
          <DropdownMenu
            align="end"
            trigger={
              <IconButton label={`Trust options for ${entry.path}`} size="sm">
                <MoreHorizontal />
              </IconButton>
            }
            items={[
              entry.decision
                ? {
                    label: 'Distrust',
                    icon: <ShieldOff />,
                    onSelect: () => void decide(entry.path, false)
                  }
                : {
                    label: 'Trust',
                    icon: <ShieldCheck />,
                    onSelect: () => void decide(entry.path, true)
                  },
              {
                label: 'Show in Explorer',
                icon: <FolderOpen />,
                onSelect: () => void invoke('settings:open-path', entry.path).catch(() => undefined)
              },
              { kind: 'separator' },
              {
                label: 'Forget decision',
                icon: <Trash2 />,
                danger: true,
                onSelect: () => void decide(entry.path, null)
              }
            ]}
          />
        </Row>
      ))}
    </Group>
  )
}

export function SessionsSection() {
  return (
    <>
      <TrustGroup />
      <SchemaGroups section="sessions" />
      <SavedTrustGroup />
      <InstructionsGroup />
      <ContextGroup />
    </>
  )
}
