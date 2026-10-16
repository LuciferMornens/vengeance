import { Suspense, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Eye, FilePen, FilePlus2, FileText, Files as FilesIcon, FolderSearch } from 'lucide-react'
import { cn } from '../../lib/cn'
import { basename, formatRelativeTime, pluralize } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { lazyWithPreload } from '../../lib/lazy-with-preload'
import { fadeUp, stagger } from '../../lib/motion'
import type { AgentState } from '../../store/agent-state'
import { IconButton, Spinner } from '../../ui'
import { fileActivity, toolActivity, type FileActivity, type FileOp } from './activity'
import { Section, TabEmpty } from './parts'

const filePreviewDialog = lazyWithPreload(() => import('./FilePreviewDialog').then((m) => m.FilePreviewDialog))
const FilePreviewDialog = filePreviewDialog.Component

const OP_ICON: Record<FileOp, typeof FileText> = { read: FileText, edit: FilePen, write: FilePlus2 }
const OP_TONE: Record<FileOp, string> = { read: 'text-info', edit: 'text-warning', write: 'text-success' }

function dirname(display: string): string {
  const i = display.lastIndexOf('/')
  return i > 0 ? display.slice(0, i) : ''
}

/** GitHub-style five-block diffstat. */
function DiffBlocks({ added, removed }: { added: number; removed: number }) {
  const total = added + removed
  // Any deletion shows at least one red block (and any addition one green), however lopsided the split.
  const red = total ? Math.max(removed > 0 ? 1 : 0, Math.min(added > 0 ? 4 : 5, Math.round((removed / total) * 5))) : 0
  const green = total ? Math.max(added > 0 ? 1 : 0, Math.min(5 - red, Math.round((added / total) * 5))) : 0
  return (
    <span className="flex gap-[2px]" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn('size-[7px] rounded-[2px]', i < green ? 'bg-success' : i < green + red ? 'bg-danger' : 'bg-hover shadow-[inset_0_0_0_1px_var(--hairline)]')} />
      ))}
    </span>
  )
}

function FileRow({ file, onOpen }: { file: FileActivity; onOpen: () => void }) {
  const Icon = OP_ICON[file.lastOp]
  const ops = [file.reads && `${file.reads} read`, file.edits && pluralize(file.edits, 'edit'), file.writes && pluralize(file.writes, 'write')].filter(Boolean).join(' · ')
  return (
    <motion.div variants={fadeUp} className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-2 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
      >
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 shadow-elev-1 [&_svg]:size-3.5', OP_TONE[file.lastOp])}>
          {file.live ? <Spinner size={13} /> : <Icon />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-xs leading-5 text-fg">{basename(file.display)}</span>
          <span className="truncate text-2xs leading-4 text-fg-3">
            {dirname(file.display) || './'} · {ops}
            {file.errors > 0 && <span className="text-danger"> · {pluralize(file.errors, 'error')}</span>}
          </span>
        </span>
        <span className="tabular flex shrink-0 items-center gap-1.5 font-mono text-2xs transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
          {file.added > 0 && <span className="text-success">+{file.added}</span>}
          {file.removed > 0 && <span className="text-danger">−{file.removed}</span>}
          {file.added === 0 && file.removed === 0 && <span className="text-fg-3">{formatRelativeTime(file.lastAt)}</span>}
        </span>
      </button>
      <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-px opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label="Preview" size="xs" onClick={onOpen}>
          <Eye />
        </IconButton>
        <IconButton label="Show in Explorer" size="xs" onClick={() => void invoke('sys:reveal', file.path)}>
          <FolderSearch />
        </IconButton>
      </div>
    </motion.div>
  )
}

export function Files({ agent }: { agent: AgentState }) {
  const { entries, streaming, tools } = agent
  const cwd = agent.info.cwd
  const files = useMemo(() => fileActivity(cwd, toolActivity({ entries, streaming, tools })), [cwd, entries, streaming, tools])
  const [preview, setPreview] = useState<FileActivity | null>(null)
  const previewLoaded = filePreviewDialog.useLoaded(preview !== null)

  if (files.length === 0) {
    return (
      <TabEmpty icon={<FilesIcon />} title="No files touched yet">
        Files the agent reads, edits or writes in this session show up here with their changes.
      </TabEmpty>
    )
  }

  const changed = files.filter((f) => f.edits + f.writes > 0)
  const readOnly = files.filter((f) => f.edits + f.writes === 0)
  const added = changed.reduce((n, f) => n + f.added, 0)
  const removed = changed.reduce((n, f) => n + f.removed, 0)

  return (
    <div className="flex flex-col gap-5 px-2 pt-3 pb-6">
      {changed.length > 0 && (
        <div className="px-2">
          <Section
            title={`Changed · ${changed.length}`}
            aside={
              <span className="tabular flex items-center gap-2 font-mono text-2xs">
                <span>
                  <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
                </span>
                <DiffBlocks added={added} removed={removed} />
              </span>
            }
          >
            <motion.div variants={stagger()} initial="hidden" animate="show" className="-mx-2 flex flex-col">
              {changed.map((file) => (
                <FileRow key={file.path} file={file} onOpen={() => setPreview(file)} />
              ))}
            </motion.div>
          </Section>
        </div>
      )}
      {readOnly.length > 0 && (
        <div className="px-2">
          <Section title={`Read · ${readOnly.length}`}>
            <motion.div variants={stagger()} initial="hidden" animate="show" className="-mx-2 flex flex-col">
              {readOnly.map((file) => (
                <FileRow key={file.path} file={file} onOpen={() => setPreview(file)} />
              ))}
            </motion.div>
          </Section>
        </div>
      )}
      {preview && previewLoaded && (
        <Suspense fallback={null}>
          <FilePreviewDialog path={preview.path} display={preview.display} cwd={agent.info.cwd} onClose={() => setPreview(null)} />
        </Suspense>
      )}
    </div>
  )
}
