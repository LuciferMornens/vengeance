import { useEffect, useState } from 'react'
import { Dialog as RDialog } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { platform } from '../../lib/ipc'
import { ModalBackdrop } from '../../ui'

export interface LightboxProps {
  src: string | null
  /** Caption name, e.g. "Attachment 2 of 3". */
  label?: string
  onClose: () => void
}

/** Small images are shown at least this wide (capped by the viewport), so a 320×200 screenshot is readable. */
const MIN_VIEW_W = 640
const FRAME_PAD = 48
const CAPTION_H = 36
/** Windows and floating Linux lay their caption buttons over the titlebar's right end: close below them. */
const CLOSE_TOP =
  platform.windowControls === 'right' ? 'top-[calc(var(--titlebar-h)+12px)]' : 'top-4'

/** Decoded byte size of a base64 `data:` URL (null for other URLs). */
function dataUrlBytes(src: string): number | null {
  const comma = src.indexOf(',')
  if (!src.startsWith('data:') || comma < 0 || !src.slice(0, comma).endsWith(';base64')) return null
  const data = src.slice(comma + 1)
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Display size: upscale small images to MIN_VIEW_W, fit everything inside the viewport, keep the aspect ratio. */
function fitSize(
  natural: { w: number; h: number },
  viewport: { w: number; h: number }
): { w: number; h: number } {
  const maxW = viewport.w - FRAME_PAD * 2
  const maxH = viewport.h - FRAME_PAD * 2 - CAPTION_H
  const upscale = Math.max(1, Math.min(MIN_VIEW_W, maxW) / natural.w)
  const scale = Math.min(upscale, maxW / natural.w, maxH / natural.h)
  return { w: Math.round(natural.w * scale), h: Math.round(natural.h * scale) }
}

function useViewport(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/**
 * Full-window image viewer with a caption (name · dimensions · size). Click anywhere or Esc to close: the viewer is
 * `no-drag`, so a click over the titlebar closes it instead of starting a window drag.
 */
export function Lightbox({ src, label, onClose }: LightboxProps) {
  const viewport = useViewport()
  const [natural, setNatural] = useState<{ src: string; w: number; h: number } | null>(null)
  const loaded = natural && natural.src === src ? natural : null
  const shown = loaded ? fitSize(loaded, viewport) : null
  const bytes = src ? dataUrlBytes(src) : null
  const facts = [
    label,
    loaded ? `${loaded.w} × ${loaded.h}` : null,
    bytes !== null ? formatBytes(bytes) : null
  ].filter(Boolean)
  return (
    <RDialog.Root open={src !== null} onOpenChange={(open) => !open && onClose()}>
      <RDialog.Portal>
        {/* A plain backdrop, not RDialog.Overlay: see ModalBackdrop in ui/Dialog.tsx. */}
        <ModalBackdrop
          open={src !== null}
          className="fixed inset-0 z-[var(--z-lightbox)] bg-[rgba(4,4,6,0.82)] backdrop-blur-md data-[state=closed]:animate-[v-fade-out_140ms_var(--ease-out)] data-[state=open]:animate-[v-fade-in_180ms_var(--ease-out)]"
        />
        <RDialog.Content
          tabIndex={-1}
          onClick={onClose}
          className="no-drag fixed inset-0 z-[var(--z-lightbox)] flex flex-col items-center justify-center gap-3 p-12 data-[state=closed]:animate-[v-fade-out_140ms_var(--ease-out)] data-[state=open]:animate-[v-sheet-in_240ms_var(--ease-out)]"
        >
          <RDialog.Title className="sr-only">{label ?? 'Image preview'}</RDialog.Title>
          <RDialog.Description className="sr-only">
            Click anywhere or press Escape to close
          </RDialog.Description>
          {src && (
            <img
              src={src}
              alt={label ?? ''}
              decoding="async"
              onLoad={(event) =>
                setNatural({
                  src,
                  w: event.currentTarget.naturalWidth,
                  h: event.currentTarget.naturalHeight
                })
              }
              style={shown ? { width: shown.w, height: shown.h } : undefined}
              className="max-h-[calc(100vh-132px)] max-w-[calc(100vw-96px)] rounded-card object-contain shadow-[0_0_0_1px_rgba(255,255,255,0.08),var(--shadow-xl)] [image-rendering:auto]"
            />
          )}
          {facts.length > 0 && (
            <div className="h-6 text-xs leading-6 text-white/60 tabular">{facts.join(' · ')}</div>
          )}
          <RDialog.Close
            className={cn(
              'absolute right-4 flex size-8 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white',
              CLOSE_TOP
            )}
          >
            <X className="size-4" />
          </RDialog.Close>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}
