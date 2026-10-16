import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, ScrollText } from 'lucide-react'
import { create } from 'zustand'
import type { EngineChangelog } from '@shared/api/updates'
import type { EngineId } from '@shared/api/engine'
import { registerActions } from '../../lib/actions'
import { invoke } from '../../lib/ipc'
import { Badge, Button, Dialog, Skeleton } from '../../ui'
import { Markdown } from '../../ui/Markdown'
import { useUpdates } from './store'

/**
 * In-app viewer for the installed engine's CHANGELOG.md. Opened by the `app.changelog` action
 * (the composer's `/changelog` built-in runs it), the Engine settings section and the Updates sheet.
 */

/** Releases rendered per page; the shipped changelog is several hundred KB. */
const RELEASES_PER_PAGE = 8

interface ChangelogStore {
  engine: EngineId
  open: boolean
  setOpen(open: boolean): void
}

const useChangelog = create<ChangelogStore>()((set) => ({
  engine: 'pi',
  open: false,
  setOpen: (open) => set({ open })
}))

export function openChangelog(engine?: EngineId): void {
  useChangelog.setState({ engine: engine ?? useUpdates.getState().engine })
  useChangelog.getState().setOpen(true)
}

registerActions([
  {
    id: 'app.changelog',
    title: 'What’s new in the engine',
    group: 'General',
    keywords: ['changelog', 'release notes', 'version', 'news'],
    icon: ScrollText,
    run: openChangelog
  }
])

interface Release {
  /** "1.1.0" from `## [1.1.0] - 2026-10-07`, else the whole heading. */
  version: string
  date?: string
  body: string
}

/** Split at `## ` release headings; anything before the first one (the `# Changelog` title) is dropped. */
function splitReleases(markdown: string): Release[] {
  return markdown
    .split(/^(?=## )/m)
    .filter((part) => part.startsWith('## '))
    .map((part) => {
      const newline = part.indexOf('\n')
      const heading = (newline < 0 ? part : part.slice(0, newline)).slice(3).trim()
      const body = newline < 0 ? '' : part.slice(newline + 1).trim()
      const match = /^\[?([^\]\s]+)\]?\s*(?:[-–—]\s*(.+))?$/.exec(heading)
      return match
        ? { version: match[1]!, date: match[2]?.trim(), body }
        : { version: heading, body }
    })
}

/** "2026-10-07" → "Oct 7, 2026"; anything else unchanged. */
function releaseDate(date: string): string {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : null
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : date
}

export function ChangelogDialog() {
  const open = useChangelog((s) => s.open)
  const engine = useChangelog((s) => s.engine)
  const setOpen = useChangelog((s) => s.setOpen)
  const [changelog, setChangelog] = useState<EngineChangelog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState(1)

  useEffect(() => {
    if (!open) return
    setPages(1)
    setError(null)
    setChangelog(null)
    let cancelled = false
    invoke('updates:changelog', engine).then(
      (next) => {
        if (!cancelled) setChangelog(next)
      },
      (error: Error) => {
        if (!cancelled) setError(error.message)
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, engine])

  const releases = useMemo(() => (changelog ? splitReleases(changelog.markdown) : []), [changelog])
  const shown = releases.slice(0, pages * RELEASES_PER_PAGE)

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="picker"
      icon={<ScrollText />}
      title="What’s new in the engine"
      description={
        changelog
          ? `Installed version ${changelog.version}`
          : 'Release notes of the installed engine'
      }
      footer={
        <>
          {changelog?.path && (
            <Button
              variant="ghost"
              leading={<FolderOpen />}
              className="mr-auto"
              onClick={() => void invoke('sys:reveal', changelog.path)}
            >
              Show file
            </Button>
          )}
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </>
      }
    >
      <div className="selectable min-h-[320px] pb-2">
        {error && (
          <p className="py-10 text-center text-sm text-fg-3">
            The changelog could not be read: {error}
          </p>
        )}
        {!error && !changelog && (
          <div className="space-y-3 py-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        )}
        {changelog && releases.length === 0 && (
          <Markdown text={changelog.markdown} size="compact" />
        )}
        {shown.map((release, index) => (
          <section
            key={index}
            className="border-b border-hairline-soft py-4 first:pt-0 last:border-b-0"
          >
            <header className="mb-2 flex items-center gap-2">
              <Badge tone={release.version === changelog?.version ? 'accent' : 'neutral'}>
                {release.version}
              </Badge>
              {release.date && (
                <span className="text-xs text-fg-3">{releaseDate(release.date)}</span>
              )}
              {release.version === changelog?.version && (
                <span className="text-xs text-fg-3">· Installed</span>
              )}
            </header>
            {release.body && <Markdown text={release.body} size="compact" />}
          </section>
        ))}
        {shown.length < releases.length && (
          <div className="flex justify-center pt-2">
            <Button size="sm" variant="ghost" onClick={() => setPages((p) => p + 1)}>
              Show older releases
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
