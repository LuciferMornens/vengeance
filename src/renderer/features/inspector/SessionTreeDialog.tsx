import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, GitFork, ListTree, SquareArrowOutUpRight, Tag } from 'lucide-react'
import type { FlatSessionTree } from '@shared/engine-types'
import { invoke } from '../../lib/ipc'
import { Button, Dialog, IconButton } from '../../ui'
import {
  continueFrom,
  forkAt,
  openSession,
  openSessionFile,
  setEntryLabel
} from '../sessions/actions'
import { SubagentSessionButtons } from '../sessions/SubagentSessionButtons'
import type { SessionTarget } from '../sessions/store'
import { useEffectiveSetting } from '../settings/effective'
import { SessionTreeView, TreeFilterChips, TreeLegend, TreeSkeleton } from './SessionTree'
import {
  buildBranchTree,
  filterBranchTree,
  isTreeFilterMode,
  type BranchNode,
  type TreeFilterMode
} from './tree-model'

/**
 * Tree of a session that is not open: browse its branches, label points (written to the file through
 * the engine's SessionManager), fork or continue from any point, or open it.
 */
export function SessionTreeDialog({
  target,
  onClose
}: {
  target: SessionTarget & { path: string }
  onClose: () => void
}) {
  const [data, setData] = useState<FlatSessionTree | null>(null)
  const [failed, setFailed] = useState(false)
  const setting = useEffectiveSetting('treeFilterMode', target.cwd, target.engine ?? 'pi')
  const [picked, setPicked] = useState<TreeFilterMode | null>(null)
  const mode = picked ?? (isTreeFilterMode(setting) ? setting : 'default')

  const load = useCallback(async () => {
    try {
      setData(await invoke('sessions:tree', target.path))
      setFailed(false)
    } catch {
      // Engine and IPC error text is not for users.
      setFailed(true)
    }
  }, [target.path])
  useEffect(() => {
    void load()
  }, [load])

  const full = useMemo(
    () => (data ? buildBranchTree(data.nodes, data.leafId, mode === 'all') : null),
    [data, mode]
  )
  const root = useMemo(() => (full ? filterBranchTree(full.root, mode) : null), [full, mode])

  const leave = (run: () => Promise<unknown>) => {
    onClose()
    void run()
  }

  const renderActions = (node: BranchNode, { editLabel }: { editLabel: () => void }) => (
    <div className="flex flex-wrap items-center gap-1">
      {node.subagentRunIds && (
        <SubagentSessionButtons
          parentPath={target.path}
          cwd={target.cwd}
          runIds={node.subagentRunIds}
          onOpen={(session) => leave(() => openSession(session))}
        />
      )}
      {node.kind === 'user' ? (
        <Button
          size="xs"
          variant="secondary"
          leading={<GitFork />}
          onClick={() =>
            leave(() =>
              forkAt(target, { entryId: node.id, parentId: node.parentId, text: node.text }, false)
            )
          }
        >
          Fork from here
        </Button>
      ) : (
        <Button
          size="xs"
          variant="secondary"
          leading={<SquareArrowOutUpRight />}
          onClick={() => leave(() => continueFrom(target, node.tipId))}
        >
          Continue in a new session
        </Button>
      )}
      <IconButton label={node.label ? 'Edit label' : 'Add label'} size="xs" onClick={editLabel}>
        <Tag />
      </IconButton>
    </div>
  )

  const saveLabel = async (node: BranchNode, label: string) => {
    const ok = await setEntryLabel({ path: target.path }, node.labelEntryId, label)
    if (ok) await load()
    return ok
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="picker"
      icon={<ListTree />}
      title={target.title}
      description="Browse every branch of this session, label points, or start a new session from any of them."
      className="max-h-[70vh]"
      bodyClassName="px-3"
      footer={
        <Button
          variant="primary"
          leading={<ExternalLink />}
          onClick={() =>
            leave(() => openSessionFile(target.path, { cwd: target.cwd, engine: target.engine }))
          }
        >
          Open session
        </Button>
      }
    >
      {!full && !failed && <TreeSkeleton />}
      {failed && (
        <div className="px-2 py-3 text-sm text-danger">
          Could not read the tree of this session file.
        </div>
      )}
      {full && root && (
        <div className="flex flex-col gap-3 pb-2">
          <div className="flex flex-col gap-2.5 px-2">
            <TreeLegend abandoned={full.abandoned} leafLabel="Latest" />
            <TreeFilterChips value={mode} onChange={setPicked} />
          </div>
          {root.children.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-fg-3">
              Nothing matches this filter.
            </div>
          ) : (
            <SessionTreeView
              key={mode}
              root={root}
              showTools={mode !== 'no-tools'}
              windowed
              leafLabel="Latest"
              renderActions={renderActions}
              saveLabel={saveLabel}
            />
          )}
        </div>
      )}
    </Dialog>
  )
}
