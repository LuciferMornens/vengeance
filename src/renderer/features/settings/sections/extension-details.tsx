import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight, Check, ShieldAlert } from 'lucide-react'
import type { GalleryPackage, GalleryPackageDetail } from '@shared/api/gallery'
import { formatRelativeTime } from '../../../lib/format'
import { Avatar, Badge, Button, Chip, Dialog, SegmentedControl, Skeleton } from '../../../ui'
import { invoke } from '../ipc'

/** Details of one gallery package: what it contains, how widely it is used, and installing it. */

export type InstallScope = 'user' | 'project'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export function formatDownloads(weekly: number | undefined): string | undefined {
  return weekly === undefined ? undefined : `${compact.format(weekly)} / week`
}

export function formatUpdated(updated: string | undefined): string | undefined {
  const at = updated ? Date.parse(updated) : NaN
  return Number.isNaN(at) ? undefined : formatRelativeTime(at)
}

function formatSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const KIND_LABELS = [
  ['extensions', 'Extension'],
  ['skills', 'Skills'],
  ['prompts', 'Prompt templates'],
  ['themes', 'Themes']
] as const

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-1 px-3 py-2.5 shadow-elev-0">
      <div className="text-xs text-fg-3">{label}</div>
      <div className="tabular mt-0.5 truncate text-ui font-medium text-fg">{value}</div>
    </div>
  )
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      trailing={<ArrowUpRight />}
      onClick={() => void invoke('sys:open-external', href)}
    >
      {children}
    </Button>
  )
}

export function ExtensionDetails({
  pkg,
  installed,
  installing,
  hasProject,
  scope,
  onScopeChange,
  onInstall,
  onManage,
  onOpenChange
}: {
  pkg: GalleryPackage | null
  installed: boolean
  installing: boolean
  hasProject: boolean
  scope: InstallScope
  onScopeChange: (scope: InstallScope) => void
  onInstall: (pkg: GalleryPackage) => void
  onManage: () => void
  onOpenChange: (open: boolean) => void
}) {
  const [detail, setDetail] = useState<{ name: string; value?: GalleryPackageDetail; error?: string }>()
  const name = pkg?.name

  useEffect(() => {
    if (!name) return
    let current = true
    setDetail({ name })
    invoke('gallery:package', name).then(
      (value) => current && setDetail({ name, value }),
      (error: Error) => current && setDetail({ name, error: error.message })
    )
    return () => {
      current = false
    }
  }, [name])

  const loaded = detail?.name === name ? detail : undefined
  const kinds = loaded?.value?.resources
  const downloads = formatDownloads(pkg?.weeklyDownloads)
  const updated = formatUpdated(pkg?.updated)

  return (
    <Dialog
      open={!!pkg}
      onOpenChange={onOpenChange}
      size="picker"
      title={
        pkg && (
          <span className="flex items-center gap-3">
            <Avatar name={pkg.displayName} size={36} className="rounded-card" />
            <span className="min-w-0">
              <span className="block truncate">{pkg.displayName}</span>
              <span className="block truncate font-mono text-xs font-normal text-fg-3">
                {pkg.name} · {pkg.version}
                {pkg.publisher && ` · by ${pkg.publisher}`}
              </span>
            </span>
          </span>
        )
      }
      footerStart={
        hasProject &&
        !installed && (
          <SegmentedControl
            size="sm"
            aria-label="Install for"
            value={scope}
            onValueChange={onScopeChange}
            segments={[
              { value: 'user', label: 'Every project' },
              { value: 'project', label: 'This project' }
            ]}
          />
        )
      }
      footer={
        pkg &&
        (installed ? (
          <Button variant="secondary" onClick={onManage}>
            Manage in Packages
          </Button>
        ) : (
          <Button variant="primary" loading={installing} onClick={() => onInstall(pkg)}>
            {installing ? 'Installing…' : 'Install'}
          </Button>
        ))
      }
    >
      {pkg && (
        <div className="space-y-5">
          <p className="text-ui leading-relaxed text-fg-2">
            {pkg.description ?? 'The author has not added a description.'}
          </p>

          <div>
            <div className="mb-2 text-xs font-medium text-fg-3">Adds</div>
            <div className="flex min-h-6 flex-wrap items-center gap-1.5">
              {!loaded || (!loaded.value && !loaded.error) ? (
                <>
                  <Skeleton className="h-6 w-24 rounded-sm" />
                  <Skeleton className="h-6 w-16 rounded-sm" />
                </>
              ) : kinds ? (
                KIND_LABELS.filter(([key]) => kinds[key]).map(([key, label]) => (
                  <Chip key={key}>{label}</Chip>
                ))
              ) : (
                <span className="text-sm text-fg-3">
                  {loaded.error ?? 'Whatever its extensions, skills, prompts and themes folders contain.'}
                </span>
              )}
              {installed && (
                <Badge tone="success" className="ml-auto">
                  <Check className="size-3" />
                  Installed
                </Badge>
              )}
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <Stat label="Downloads" value={downloads ?? '—'} />
            <Stat label="Updated" value={updated ?? '—'} />
            <Stat label="License" value={pkg.license ?? '—'} />
            <Stat label="Size" value={formatSize(loaded?.value?.unpackedSize) ?? '—'} />
          </div>

          <div className="flex gap-2.5 rounded-card bg-warning-soft px-3.5 py-3 text-sm leading-relaxed text-fg-2 shadow-[inset_0_0_0_1px_var(--warning-border)]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              Extensions run with your permissions and can read files and run commands. Install packages from
              authors you trust, and look through the source first.
            </span>
          </div>

          <div className="-ml-2 flex flex-wrap gap-1">
            {pkg.repository && <LinkButton href={pkg.repository}>Source</LinkButton>}
            {pkg.homepage && pkg.homepage !== pkg.repository && (
              <LinkButton href={pkg.homepage}>Homepage</LinkButton>
            )}
            {loaded?.value?.preview && <LinkButton href={loaded.value.preview}>Preview</LinkButton>}
            <LinkButton href={pkg.npmUrl}>npm</LinkButton>
          </div>
        </div>
      )}
    </Dialog>
  )
}
