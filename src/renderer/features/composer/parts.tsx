import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, CornerDownRight, ImageIcon, ListEnd, SquareTerminal, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import type { BashRun } from '../../store/agent-state'
import { Spinner, Tooltip } from '../../ui'
import type { ImageAttachment, PendingAttachment } from './drafts'

// ─── Attachment tray ─────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Keep the start and the extension of long file names: `very-long-scre…shot.png`. */
export function middleEllipsis(name: string, max = 24): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const tail = dot > 0 && name.length - dot <= 6 ? name.slice(dot - 4) : name.slice(-8)
  return `${name.slice(0, max - tail.length - 1)}…${tail}`
}

const attachmentCard = 'group relative flex h-12 max-w-[220px] items-center gap-2.5 rounded-card bg-surface-3 py-1.5 pr-3 pl-1.5 shadow-[inset_0_0_0_1px_var(--hairline)]'

export function AttachmentTray({
  images,
  pending,
  onRemove,
  imagesUnsupported
}: {
  images: ImageAttachment[]
  pending: PendingAttachment[]
  onRemove(id: string): void
  imagesUnsupported?: string
}) {
  if (images.length === 0 && pending.length === 0) return null
  return (
    <div className="px-2.5 pt-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <AnimatePresence initial={false}>
          {images.map((image) => (
            <motion.div
              key={image.id}
              layout
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.12 } }}
              transition={spring.snappy}
              className={attachmentCard}
            >
              <div className="size-9 shrink-0 overflow-hidden rounded-md bg-surface-4 shadow-[0_0_0_1px_var(--hairline)]">
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="" className="size-full object-cover" draggable={false} />
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-fg" title={image.name}>
                  {middleEllipsis(image.name)}
                </span>
                <span className="tabular truncate text-2xs text-fg-3">
                  {image.width}×{image.height} · {formatBytes(image.bytes)}
                </span>
              </div>
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => onRemove(image.id)}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-surface-4 text-fg-2 opacity-0 shadow-elev-1 transition-opacity duration-[var(--dur-instant)] group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </motion.div>
          ))}
          {pending.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              className={attachmentCard}
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-4 text-fg-3">
                <Spinner size={14} />
              </div>
              <span className="truncate text-sm text-fg-3" title={item.name}>
                {middleEllipsis(item.name)}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {imagesUnsupported && (
        <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle className="size-3" />
          {imagesUnsupported}
        </div>
      )}
    </div>
  )
}

// ─── Queue chips ─────────────────────────────────────────────────────────────────────────────

export interface QueuedItem {
  kind: 'steering' | 'followUp'
  text: string
  /** Position within its queue (steering or follow-up). */
  index: number
  /** Images queued with the message (remembered by the composer; the engine queue is text only). */
  images: number
}

export function QueueChips({ items, onRemove, onRestore }: { items: QueuedItem[]; onRemove(item: QueuedItem): void; onRestore(): void }) {
  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && (
        <motion.div
          key="queue"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={spring.layout}
          className="overflow-hidden"
        >
          <div className="flex items-start gap-2 border-b border-hairline-soft px-2.5 pt-1 pb-2">
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              <AnimatePresence initial={false}>
                {items.map((item) => (
                  <motion.span
                    key={`${item.kind}-${item.index}-${item.text}`}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.1 } }}
                    transition={spring.snappy}
                    className={cn(
                      'inline-flex h-6 max-w-[320px] items-center gap-1.5 rounded-sm pr-1 pl-2 text-sm',
                      item.kind === 'steering' ? 'bg-accent-soft text-accent-text shadow-[inset_0_0_0_1px_var(--accent-border)]' : 'bg-hover text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)]'
                    )}
                  >
                    {item.kind === 'steering' ? <CornerDownRight className="size-3 shrink-0" /> : <ListEnd className="size-3 shrink-0" />}
                    <span className="shrink-0 text-xs font-medium opacity-80">{item.kind === 'steering' ? 'Steer' : 'Follow-up'}</span>
                    <span className="truncate">{item.text}</span>
                    {item.images > 0 && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs opacity-80" title={`${item.images} ${item.images === 1 ? 'image' : 'images'}`}>
                        <ImageIcon className="size-3" />
                        {item.images}
                      </span>
                    )}
                    <button type="button" aria-label="Remove queued message" onClick={() => onRemove(item)} className="rounded-xs p-0.5 opacity-70 hover:bg-active hover:opacity-100">
                      <X className="size-3" />
                    </button>
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
            <Tooltip content="Move queued messages back into the editor" hotkey="alt+↑" side="top">
              <button type="button" onClick={onRestore} className="h-6 shrink-0 rounded-sm px-2 text-xs text-fg-3 hover:bg-hover hover:text-fg-2">
                Edit queue
              </button>
            </Tooltip>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ─── Running `!command` row ──────────────────────────────────────────────────────────────────

export function BashRunningRow({ run, onStop }: { run: BashRun; onStop(): void }) {
  const lastLine = run.output.replace(/\u001b\[[0-9;]*m/g, '').trimEnd().split('\n').pop() ?? ''
  return (
    <div className="flex items-center gap-2 border-b border-hairline-soft px-3 pt-1 pb-2 text-xs">
      <SquareTerminal className="size-3.5 shrink-0 text-fg-3" />
      <span className="shrink-0 font-mono text-fg-2">$ {run.command}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-fg-4">{lastLine}</span>
      <Spinner size={12} className="text-fg-3" />
      <button type="button" onClick={onStop} className="h-5 rounded-xs px-1.5 text-xs font-medium text-fg-3 hover:bg-hover hover:text-danger">
        Stop
      </button>
    </div>
  )
}
