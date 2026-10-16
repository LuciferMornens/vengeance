import { memo, useState } from 'react'
import type { ImageContent, UserMessage } from '@shared/engine-types'
import { Lightbox } from './Lightbox'
import { UserActions } from './MessageActions'
import { userText } from './transcript-items'

/** Right-aligned soft bubble with image thumbnails (click → lightbox) and hover actions (none when `readOnly`). */
export const UserMessageView = memo(function UserMessageView({ agentId, message, readOnly }: { agentId: string; message: UserMessage; readOnly: boolean }) {
  const [preview, setPreview] = useState<number | null>(null)
  // The viewer mounts on first use (most messages never open it) and stays for its close animation.
  const [viewerUsed, setViewerUsed] = useState(false)
  const text = userText(message)
  const images = typeof message.content === 'string' ? [] : message.content.filter((c): c is ImageContent => c.type === 'image')
  return (
    <div className="group/user relative flex flex-col items-end">
      {images.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((image, i) => {
            const src = `data:${image.mimeType};base64,${image.data}`
            return (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setViewerUsed(true)
                  setPreview(i)
                }}
                className="overflow-hidden rounded-card shadow-[0_0_0_1px_var(--hairline),var(--shadow-sm)] transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] hover:scale-[1.02]"
              >
                <img src={src} alt={`Attachment ${i + 1}`} loading="lazy" decoding="async" className="h-24 max-w-56 object-cover" />
              </button>
            )
          })}
        </div>
      )}
      {text && (
        <div className="selectable max-w-[85%] rounded-lg rounded-br-sm bg-[var(--user-bubble)] px-4 py-2.5 text-prose leading-[var(--leading-prose)] break-words whitespace-pre-wrap text-fg shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
          {text}
        </div>
      )}
      {!readOnly && <UserActions agentId={agentId} message={message} className="absolute top-full right-0 z-[1] -mr-1 pt-1 opacity-0 transition-opacity duration-[var(--dur-base)] group-hover/user:opacity-100 focus-within:opacity-100" />}
      {viewerUsed && (
        <Lightbox
          src={preview === null || !images[preview] ? null : `data:${images[preview].mimeType};base64,${images[preview].data}`}
          label={preview === null ? undefined : images.length > 1 ? `Attachment ${preview + 1} of ${images.length}` : 'Attachment'}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  )
})
