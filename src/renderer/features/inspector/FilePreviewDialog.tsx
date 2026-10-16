import { useEffect, useState } from 'react'
import { FileWarning, FolderSearch } from 'lucide-react'
import type { ReadFileResult } from '@shared/api/system'
import { invoke } from '../../lib/ipc'
import { Button, Dialog, Skeleton } from '../../ui'

/** Read-only, line-numbered preview of a workspace file (bounded read through sys:read-file). */
export function FilePreviewDialog({ path, display, cwd, onClose }: { path: string; display: string; cwd: string; onClose: () => void }) {
  const [file, setFile] = useState<ReadFileResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    invoke('sys:read-file', path, { cwd, maxBytes: 512 * 1024 })
      .then(setFile)
      .catch((e: Error) => setError(e.message))
  }, [path, cwd])

  const lines = file && !file.binary ? file.content.replace(/\n$/, '').split('\n') : []
  const gutter = String(lines.length).length

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      width={820}
      title={<span className="font-mono text-ui">{display}</span>}
      description={file ? `${lines.length.toLocaleString()} lines · ${(file.size / 1024).toFixed(file.size < 10_240 ? 1 : 0)} KB${file.truncated ? ' · truncated preview' : ''}` : 'Loading…'}
      footer={
        <Button variant="ghost" size="sm" leading={<FolderSearch />} onClick={() => void invoke('sys:reveal', file?.path ?? path)}>
          Show in Explorer
        </Button>
      }
      className="h-[min(78vh,760px)]"
    >
      {!file && !error && (
        <div className="flex flex-col gap-2 py-2">
          {[90, 70, 84, 52, 76].map((w) => (
            <Skeleton key={w} className="h-3" />
          ))}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-3">
          <FileWarning className="size-4 text-warning" /> {error}
        </div>
      )}
      {file?.binary && <div className="py-6 text-sm text-fg-3">Binary file — no text preview.</div>}
      {file && !file.binary && (
        <pre className="selectable -mx-5 min-h-full overflow-x-auto bg-[color-mix(in_oklab,var(--bg)_60%,transparent)] py-3 font-mono text-xs leading-[1.7] text-fg-2 shadow-[inset_0_1px_0_var(--hairline-soft)]">
          {lines.map((line, i) => (
            <div key={i} className="flex hover:bg-hover">
              <span className="tabular sticky left-0 shrink-0 bg-[inherit] pr-4 pl-5 text-right text-fg-4 select-none" style={{ width: `${gutter + 4}ch` }}>
                {i + 1}
              </span>
              <span className="pr-5 whitespace-pre">{line || ' '}</span>
            </div>
          ))}
        </pre>
      )}
    </Dialog>
  )
}
