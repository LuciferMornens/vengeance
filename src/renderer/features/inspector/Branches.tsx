import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CopyPlus,
  CornerDownLeft,
  CornerDownRight,
  GitFork,
  ListTree,
  RefreshCw,
  SquareArrowOutUpRight,
  Tag
} from 'lucide-react'
import type { FlatSessionTree } from '@shared/engine-types'
import type { EngineId } from '@shared/api/engine'
import { bridge } from '../../lib/bridge'
import { cn } from '../../lib/cn'
import { rpc } from '../../lib/engine'
import type { AgentState } from '../../store/agent-state'
import { Button, IconButton } from '../../ui'
import {
  cloneSession,
  continueFrom,
  forkAt,
  goToPoint,
  setEntryLabel,
  targetForAgent
} from '../sessions/actions'
import { SubagentSessionButtons } from '../sessions/SubagentSessionButtons'
import { getEffectiveSetting, useEffectiveSetting } from '../settings/effective'
import { NavigateDialog } from './NavigateDialog'
import { Section, TabEmpty } from './parts'
import { SessionTreeView, TreeFilterChips, TreeLegend, TreeSkeleton } from './SessionTree'
import {
  buildBranchTree,
  filterBranchTree,
  isTreeFilterMode,
  navigationTarget,
  type BranchNode,
  type TreeFilterMode
} from './tree-model'

/** Tree data of the open session, reloaded when messages land, the session file changes, or after an action. */
function useSessionTree(agent: AgentState) {
  const [data, setData] = useState<FlatSessionTree | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const sessionFile = agent.session?.sessionFile ?? agent.info.sessionFile
  const ready = agent.status === 'ready'

  const load = useCallback(async () => {
    if (!ready) return
    setLoading(true)
    try {
      setData(await rpc(agent.id, { type: 'get_tree' }))
      setFailed(false)
    } catch {
      // Engine and IPC error text is not for users; the empty state explains and offers a retry.
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [agent.id, ready])

  useEffect(() => {
    void load()
  }, [load, agent.entries.length, sessionFile])

  return { data, failed, loading, load }
}

/** The filter the tree opens with: the engine's `treeFilterMode` setting until the user picks one. */
function useTreeFilter(
  cwd: string,
  engine: EngineId
): [TreeFilterMode, (mode: TreeFilterMode) => void] {
  const setting = useEffectiveSetting('treeFilterMode', cwd, engine)
  const [picked, setPicked] = useState<TreeFilterMode | null>(null)
  return [picked ?? (isTreeFilterMode(setting) ? setting : 'default'), setPicked]
}

export function Branches({ agent }: { agent: AgentState }) {
  const { data, failed, loading, load } = useSessionTree(agent)
  const [mode, setMode] = useTreeFilter(agent.info.cwd, agent.info.engine)
  const [navigating, setNavigating] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<BranchNode | null>(null)
  const live = bridge.available(agent.id)
  const running = agent.phase === 'running'

  const full = useMemo(
    () => (data ? buildBranchTree(data.nodes, data.leafId, mode === 'all') : null),
    [data, mode]
  )
  const root = useMemo(() => (full ? filterBranchTree(full.root, mode) : null), [full, mode])

  const navigate = async (
    node: BranchNode,
    options: { summarize: boolean; customInstructions?: string }
  ) => {
    setNavigating(node.id)
    const ok = await goToPoint(agent.id, navigationTarget(node), options)
    setNavigating(null)
    if (ok) await load()
    return ok
  }

  const goTo = (node: BranchNode) => {
    if (getEffectiveSetting('branchSummary.skipPrompt', agent.info.cwd, agent.info.engine) === true)
      void navigate(node, { summarize: false })
    else setPrompt(node)
  }

  if (!full && !failed) return <TreeSkeleton />
  if (failed) {
    return (
      <TabEmpty icon={<ListTree />} title="Could not load the session tree">
        The engine did not send the tree of this session.
        <Button
          size="xs"
          variant="secondary"
          leading={<RefreshCw />}
          loading={loading}
          onClick={() => void load()}
          className="mt-3"
        >
          Try again
        </Button>
      </TabEmpty>
    )
  }
  if (!full || !root || full.root.children.length === 0) {
    return (
      <TabEmpty icon={<ListTree />} title="No branches yet">
        Every message becomes a point you can return to, fork or label. Send a message to start the
        tree.
      </TabEmpty>
    )
  }

  const target = targetForAgent(agent.id)
  const renderActions = (node: BranchNode, { editLabel }: { editLabel: () => void }) => {
    if (!target) return null
    const here = node.isLeaf && navigationTarget(node) === data?.leafId
    const subagentSessions =
      node.subagentRunIds && target.path ? (
        <SubagentSessionButtons
          parentPath={target.path}
          cwd={target.cwd}
          runIds={node.subagentRunIds}
        />
      ) : null
    if (!live) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {subagentSessions}
          {node.kind === 'user' && (
            <Button
              size="xs"
              variant="secondary"
              leading={<GitFork />}
              onClick={() =>
                void forkAt(
                  target,
                  { entryId: node.id, parentId: node.parentId, text: node.text },
                  node.onPath
                )
              }
            >
              Fork from here
            </Button>
          )}
          {node.isLeaf ? (
            <Button
              size="xs"
              variant="secondary"
              leading={<CopyPlus />}
              onClick={() => void cloneSession(target)}
            >
              Clone session
            </Button>
          ) : (
            <Button
              size="xs"
              variant="secondary"
              leading={<CornerDownRight />}
              onClick={() => void continueFrom(target, node.tipId)}
            >
              Continue from here
            </Button>
          )}
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          {subagentSessions}
          {!here && (
            <Button
              size="xs"
              variant="secondary"
              leading={<CornerDownLeft />}
              loading={navigating === node.id}
              onClick={() => goTo(node)}
            >
              Go to this point
            </Button>
          )}
          {node.kind === 'user' && (
            <IconButton
              label="Fork into a new session"
              size="xs"
              onClick={() =>
                void forkAt(
                  target,
                  { entryId: node.id, parentId: node.parentId, text: node.text },
                  node.onPath
                )
              }
            >
              <GitFork />
            </IconButton>
          )}
          {node.isLeaf ? (
            <IconButton label="Clone session" size="xs" onClick={() => void cloneSession(target)}>
              <CopyPlus />
            </IconButton>
          ) : (
            <IconButton
              label="Continue in a new session"
              size="xs"
              onClick={() => void continueFrom(target, node.tipId)}
            >
              <SquareArrowOutUpRight />
            </IconButton>
          )}
          <IconButton label={node.label ? 'Edit label' : 'Add label'} size="xs" onClick={editLabel}>
            <Tag />
          </IconButton>
        </div>
        {node.kind === 'user' && !here && (
          <span className="text-2xs text-fg-3">Your message goes back into the composer.</span>
        )}
      </div>
    )
  }

  const saveLabel = async (node: BranchNode, label: string) => {
    const ok = await setEntryLabel({ agentId: agent.id }, node.labelEntryId, label)
    if (ok) await load()
    return ok
  }

  return (
    <div className="flex flex-col gap-3 px-2 pt-3 pb-6">
      <div className="flex flex-col gap-2.5 px-2">
        <Section
          title="Session tree"
          aside={
            <IconButton label="Refresh" size="xs" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn(loading && 'animate-[v-spin_0.8s_linear_infinite]')} />
            </IconButton>
          }
        >
          <TreeLegend abandoned={full.abandoned} />
        </Section>
        <TreeFilterChips value={mode} onChange={setMode} />
      </div>
      <div>
        {root.children.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-fg-3">
            {mode === 'labeled-only'
              ? 'No labeled points yet. Select a step and add a label.'
              : 'Nothing matches this filter.'}
          </div>
        ) : (
          <SessionTreeView
            key={mode}
            root={root}
            showTools={mode !== 'no-tools'}
            windowed
            renderActions={renderActions}
            saveLabel={live ? saveLabel : undefined}
          />
        )}
      </div>
      <p className="px-4 text-2xs leading-relaxed text-fg-3">
        {live
          ? 'Select a step to go back to it in place, fork it into a new session or label it. Branches you leave stay in the tree.'
          : 'Select a step to fork from one of your messages or continue in a new session from any point. Nothing on the current branch is lost.'}
      </p>
      {prompt && (
        <NavigateDialog
          userMessage={prompt.kind === 'user'}
          running={running}
          onCancel={() => setPrompt(null)}
          onConfirm={(options) => navigate(prompt, options)}
        />
      )}
    </div>
  )
}
