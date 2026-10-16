import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { PackageInfo } from '@shared/api/settings'
import type { EngineId } from '@shared/api/engine'
import { settingsInvokeForFolder } from './ipc'
import { normalizePath } from '../../lib/paths'
import { Button, toast } from '../../ui'
import { useRuns, type ProcessRun } from './process-log'

/**
 * Recovery for an engine that exits because a package's extension failed to load: one "Remove <package>"
 * action per package to blame, so a broken entry in settings never leaves every session stuck.
 */

/** The Engine prints `Failed to load extension "<path>": <reason>` for each failure before it exits. */
const FAILED_EXTENSION = /Failed to load extension "([^"]+)"/g

/** Configured packages that own an extension the Engine failed to load. */
export function packagesBlamedBy(stderr: string, packages: PackageInfo[]): PackageInfo[] {
  const failed = [...stderr.matchAll(FAILED_EXTENSION)].map((match) => normalizePath(match[1]!))
  return packages.filter((pkg) => {
    if (!pkg.installedPath) return false
    const root = normalizePath(pkg.installedPath)
    return failed.some(
      (path) => path === root || (path.startsWith(root) && /[\\/]/.test(path.charAt(root.length)))
    )
  })
}

function finishedRun(runId: string): Promise<ProcessRun> {
  return new Promise((resolve) => {
    const settle = (runs: Record<string, ProcessRun>): boolean => {
      const run = runs[runId]
      if (!run || run.status === 'running') return false
      resolve(run)
      return true
    }
    const unsubscribe = useRuns.subscribe((state) => {
      if (settle(state.runs)) unsubscribe()
    })
    if (settle(useRuns.getState().runs)) unsubscribe()
  })
}

export interface PackageRecoveryActionsProps {
  engine?: EngineId
  /** Workspace of the engine that stopped (project packages are listed for it). */
  cwd: string
  /** The engine's stderr. */
  log: string
  /** A package was removed: restart the engine. */
  onRemoved: () => void
}

export function PackageRecoveryActions({
  engine = 'pi',
  cwd,
  log,
  onRemoved
}: PackageRecoveryActionsProps) {
  const [blamed, setBlamed] = useState<PackageInfo[]>([])
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setBlamed([])
    if (!log.includes('Failed to load extension')) return
    settingsInvokeForFolder(engine, cwd, 'settings:packages', cwd)
      .then((packages) => current && setBlamed(packagesBlamedBy(log, packages)))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [engine, cwd, log])

  const remove = async (pkg: PackageInfo) => {
    setRemoving(pkg.source)
    try {
      const runId = await settingsInvokeForFolder(engine, cwd, 'settings:package-run', {
        action: 'remove',
        source: pkg.source,
        local: pkg.scope === 'project',
        cwd
      })
      useRuns.getState().label(runId, `Removing ${pkg.displayName}`, engine)
      const run = await finishedRun(runId)
      if (run.status !== 'ok')
        throw new Error(run.error ?? run.summary ?? 'The Engine could not remove it.')
      toast({ level: 'success', title: `Removed ${pkg.displayName}` })
      onRemoved()
    } catch (error) {
      toast({
        level: 'error',
        title: `Could not remove ${pkg.displayName}`,
        description: (error as Error).message
      })
    } finally {
      setRemoving(null)
    }
  }

  if (blamed.length === 0) return null
  const explanation =
    blamed.length === 1
      ? `${blamed[0]!.displayName} failed to load. Remove it from your packages to start the engine without it.`
      : 'These packages failed to load. Remove them from your packages to start the engine without them.'
  return (
    <div className="mt-4 border-t border-hairline-soft pt-4">
      <p className="text-sm leading-relaxed text-fg-2">{explanation}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {blamed.map((pkg) => (
          <Button
            key={`${pkg.scope}:${pkg.source}`}
            variant="secondary"
            leading={<Trash2 />}
            loading={removing === pkg.source}
            disabled={removing !== null}
            onClick={() => void remove(pkg)}
          >
            Remove {pkg.displayName}
          </Button>
        ))}
      </div>
    </div>
  )
}
