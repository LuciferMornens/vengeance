import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import {
  ArrowUpCircle,
  CircleAlert,
  Download,
  ExternalLink,
  FolderGit2,
  FolderOpen,
  MoreHorizontal,
  Package,
  ShieldQuestion,
  Sparkles,
  Trash2
} from 'lucide-react'
import type { PackageAction, PackageInfo } from '@shared/api/settings'
import { friendlyExtensionName } from '@shared/display-names'
import { isTarballSource, TARBALL_HINT } from '@shared/package-sources'
import { runAction } from '../../../lib/actions'
import { cn } from '../../../lib/cn'
import { useApp } from '../../../store/app'
import { useEngineCapabilities } from '../../engines/registry'
import { invoke, on } from '../ipc'
import {
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  Input,
  SegmentedControl,
  Skeleton,
  Switch,
  toast,
  Tooltip
} from '../../../ui'
import { Group, Note, Row } from '../layout'
import { ProcessLog, useRuns } from '../process-log'
import { activeCwd, useSettings } from '../store'

/** Installed engine packages (npm / git / local) with streamed install, update and remove. */

const KIND_ICON = { npm: Package, git: FolderGit2, local: FolderOpen } as const

function ResourceCounts({ resources }: { resources: PackageInfo['resources'] }) {
  const parts = (
    [
      ['extensions', 'extension'],
      ['skills', 'skill'],
      ['prompts', 'prompt'],
      ['themes', 'theme']
    ] as const
  )
    .filter(([key]) => resources[key] > 0)
    .map(
      ([key, singular]) => `${resources[key]} ${resources[key] === 1 ? singular : `${singular}s`}`
    )
  return <>{parts.length ? parts.join(' · ') : 'No resources'}</>
}

function packageUrl(pkg: PackageInfo): string | undefined {
  if (pkg.homepage) return pkg.homepage
  if (pkg.kind === 'npm') return `https://www.npmjs.com/package/${pkg.name}`
  const git = /(?:git:|https:\/\/)?(github\.com\/[^@\s]+?)(?:\.git)?(?:@.*)?$/.exec(pkg.source)
  return git ? `https://${git[1]}` : undefined
}

export function PackagesSection() {
  const scope = useSettings((s) => s.scope)
  const hasProject = useSettings((s) => !!s.snapshot?.project)
  const engine = useSettings((s) => s.engine)
  const capabilities = useEngineCapabilities(engine)
  const canDiscover = !!capabilities?.packages && capabilities.extensionUi
  const discover = () => useApp.getState().openSettings('extensions', engine)
  const [packages, setPackages] = useState<PackageInfo[] | null>(null)
  const [source, setSource] = useState('')
  const [installScope, setInstallScope] = useState<'user' | 'project'>(
    scope === 'project' ? 'project' : 'user'
  )
  const [activeRun, setActiveRun] = useState<string | null>(null)
  const run = useRuns((s) => (activeRun ? s.runs[activeRun] : undefined))
  const dismiss = useRuns((s) => s.dismiss)

  const reload = useCallback(
    async () => setPackages(await invoke('settings:packages', activeCwd())),
    []
  )
  useEffect(() => {
    void reload()
    return on('settings:changed', ({ area }) => {
      if (area === 'packages' || area === 'settings' || area === 'trust') void reload()
    })
  }, [reload])
  useEffect(() => setInstallScope(scope === 'project' ? 'project' : 'user'), [scope])

  const busy = run?.status === 'running'
  const tarball = isTarballSource(source)
  const start = async (
    action: PackageAction,
    label: string,
    pkgSource?: string,
    local?: boolean
  ) => {
    if (activeRun) dismiss(activeRun)
    const engine = useSettings.getState().engine
    try {
      const runId = await invoke('settings:package-run', {
        action,
        source: pkgSource,
        local,
        cwd: activeCwd()
      })
      useRuns.getState().label(runId, label, engine)
      setActiveRun(runId)
    } catch (error) {
      toast({ level: 'error', title: `${label} failed`, description: (error as Error).message })
    }
  }

  const install = () => {
    const value = source.trim()
    if (!value || tarball) return
    void start(
      'install',
      `Installing ${friendlyExtensionName(value)}`,
      value,
      installScope === 'project'
    )
    setSource('')
  }

  const setEnabled = async (pkg: PackageInfo, enabled: boolean) => {
    setPackages(
      (list) =>
        list?.map((p) =>
          p.source === pkg.source && p.scope === pkg.scope ? { ...p, disabled: !enabled } : p
        ) ?? null
    )
    try {
      setPackages(
        await invoke(
          'settings:package-enable',
          activeCwd(),
          { source: pkg.source, scope: pkg.scope },
          enabled
        )
      )
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not change package',
        description: (error as Error).message
      })
      void reload()
    }
  }

  const user = packages?.filter((p) => p.scope === 'user') ?? []
  const project = packages?.filter((p) => p.scope === 'project') ?? []
  const awaitingTrust = project.some((p) => p.awaitingTrust)

  const renderPackage = (pkg: PackageInfo) => {
    const Icon = KIND_ICON[pkg.kind]
    const url = packageUrl(pkg)
    return (
      <Row
        key={`${pkg.scope}:${pkg.source}`}
        settingKey={`package.${pkg.name}`}
        dimmed={pkg.disabled}
        label={
          <span className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-card bg-surface-3 text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
              <Icon className="size-4" />
            </span>
            <span className="truncate" title={pkg.name}>
              {pkg.displayName}
            </span>
          </span>
        }
        badges={
          <>
            {pkg.version && (
              <span className="tabular font-mono text-xs text-fg-3">{pkg.version}</span>
            )}
            {pkg.awaitingTrust && <Badge tone="info">Not loaded · folder not trusted</Badge>}
            {!pkg.installed && !pkg.awaitingTrust && <Badge tone="warning">Not installed</Badge>}
            {pkg.filtered && !pkg.disabled && <Badge>Filtered</Badge>}
            {pkg.disabled && <Badge>Disabled</Badge>}
          </>
        }
        description={
          <span className="ml-11 block">
            {pkg.description && <span className="line-clamp-1 text-fg-3">{pkg.description}</span>}
            <span className="text-xs text-fg-3">
              <span className="font-mono">{pkg.name}</span> ·{' '}
              <ResourceCounts resources={pkg.resources} />
            </span>
          </span>
        }
      >
        <div className="flex items-center gap-1.5">
          <Tooltip content={pkg.disabled ? 'Enable package' : 'Disable without uninstalling'}>
            <span>
              <Switch
                aria-label={`Enable ${pkg.displayName}`}
                checked={!pkg.disabled}
                onCheckedChange={(on) => void setEnabled(pkg, on)}
              />
            </span>
          </Tooltip>
          <DropdownMenu
            align="end"
            trigger={
              <IconButton label="Package actions" size="sm" disabled={busy}>
                <MoreHorizontal />
              </IconButton>
            }
            items={[
              ...(pkg.kind !== 'local'
                ? [
                    {
                      label: 'Update',
                      icon: <ArrowUpCircle />,
                      onSelect: () =>
                        void start(
                          'update',
                          `Updating ${pkg.displayName}`,
                          pkg.source,
                          pkg.scope === 'project'
                        )
                    }
                  ]
                : []),
              ...(url
                ? [
                    {
                      label: 'Open homepage',
                      icon: <ExternalLink />,
                      onSelect: () => void invoke('sys:open-external', url)
                    }
                  ]
                : []),
              ...(pkg.installedPath
                ? [
                    {
                      label: 'Reveal folder',
                      icon: <FolderOpen />,
                      onSelect: () => void invoke('sys:reveal', pkg.installedPath!)
                    }
                  ]
                : []),
              { kind: 'separator' as const },
              {
                label: 'Uninstall',
                icon: <Trash2 />,
                danger: true,
                onSelect: () =>
                  void start(
                    'remove',
                    `Removing ${pkg.displayName}`,
                    pkg.source,
                    pkg.scope === 'project'
                  )
              }
            ]}
          />
        </div>
      </Row>
    )
  }

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-2 rounded-card bg-surface-2 p-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-sm)]',
          tarball ? 'mb-2' : 'mb-6'
        )}
      >
        <Download className="ml-1.5 size-4 shrink-0 text-fg-3" />
        <Input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && install()}
          placeholder="npm:@scope/pkg, git:github.com/user/repo, or a local path"
          spellCheck={false}
          className="h-8 flex-1 bg-transparent font-mono text-sm shadow-none focus:shadow-none"
        />
        {hasProject && (
          <SegmentedControl
            size="sm"
            value={installScope}
            onValueChange={setInstallScope}
            segments={[
              { value: 'user', label: 'Global' },
              { value: 'project', label: 'Project' }
            ]}
          />
        )}
        <Button variant="primary" disabled={!source.trim() || tarball || busy} onClick={install}>
          Install
        </Button>
      </div>
      {tarball && (
        <p role="status" className="mb-6 flex items-center gap-1.5 px-2 text-sm text-warning">
          <CircleAlert className="size-3.5 shrink-0" />
          {TARBALL_HINT}
        </p>
      )}

      <AnimatePresence>
        {run && (
          <ProcessLog
            key={run.runId}
            run={run}
            cancellable
            className="mb-6"
            onDismiss={() => setActiveRun(null)}
          />
        )}
      </AnimatePresence>

      {!packages ? (
        <Group title="Installed">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3.5 last:border-b-0"
            >
              <Skeleton className="size-8 rounded-card" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
            </div>
          ))}
        </Group>
      ) : (
        <>
          <Group
            title="Global"
            description="Installed for every project."
            actions={
              <>
                {canDiscover && user.length > 0 && (
                  <Button size="sm" variant="ghost" leading={<Sparkles />} onClick={discover}>
                    Discover
                  </Button>
                )}
                {user.some((p) => p.kind !== 'local') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    leading={<ArrowUpCircle />}
                    disabled={busy}
                    onClick={() => void start('update-all', 'Updating all packages')}
                  >
                    Update all
                  </Button>
                )}
              </>
            }
          >
            {user.length === 0 && (
              <Note icon={<Package />}>
                No packages yet. Install one above from npm, git or a local folder.{' '}
                {canDiscover && (
                  <button
                    type="button"
                    onClick={discover}
                    className="font-medium text-fg-2 underline decoration-hairline-strong underline-offset-2 hover:text-fg"
                  >
                    Browse community extensions
                  </button>
                )}
              </Note>
            )}
            {user.map(renderPackage)}
          </Group>
          {hasProject && (
            <Group
              title="This project"
              description={
                awaitingTrust
                  ? 'Listed in the project’s settings. They load once you trust this folder.'
                  : 'Listed in the project’s settings and installed when a session first starts here.'
              }
              actions={
                awaitingTrust && (
                  <Button
                    size="sm"
                    variant="secondary"
                    leading={<ShieldQuestion />}
                    onClick={() => runAction('workspace.trust')}
                  >
                    Trust this folder
                  </Button>
                )
              }
              className={cn(project.length === 0 && 'opacity-90')}
            >
              {project.length === 0 && <Note>No project packages.</Note>}
              {project.map(renderPackage)}
            </Group>
          )}
        </>
      )}
    </>
  )
}
