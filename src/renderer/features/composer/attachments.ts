import { useCallback, useEffect, useState, type ClipboardEvent } from 'react'
import { invoke } from '../../lib/ipc'
import { toast } from '../../ui'
import type { Draft, DraftPatch, ImageAttachment } from './drafts'
import { attachmentId, base64ToBlob, isImageFile, prepareImage } from './images'
import { mentionText } from './suggestions'

interface AttachmentOptions {
  cwd: string
  patchDraft(patch: DraftPatch): void
  insertAtCaret(snippet: string): void
}

/**
 * Decoded images join the draft in paste/drop order, not in the order their decodes finish: image `id` (null when
 * it failed) fills its placeholder, then the leading placeholders that are ready move into the draft. One still
 * decoding holds back every placeholder after it.
 */
function settle(draft: Draft, id: string, image: ImageAttachment | null): Partial<Draft> {
  const pending = image
    ? draft.pending.map((slot) => (slot.id === id ? { ...slot, image } : slot))
    : draft.pending.filter((slot) => slot.id !== id)
  const ready: ImageAttachment[] = []
  for (const slot of pending) {
    if (!slot.image) break
    ready.push(slot.image)
  }
  return { pending: pending.slice(ready.length), images: [...draft.images, ...ready] }
}

export function useComposerAttachments({ cwd, patchDraft, insertAtCaret }: AttachmentOptions) {
  const [dragging, setDragging] = useState(false)
  const addImage = useCallback(
    async (name: string, load: () => Promise<Blob>) => {
      const id = attachmentId()
      patchDraft((draft) => ({ pending: [...draft.pending, { id, name }] }))
      try {
        const image = await prepareImage(await load(), name, id)
        patchDraft((draft) => settle(draft, id, image))
      } catch (error) {
        patchDraft((draft) => settle(draft, id, null))
        toast({
          level: 'error',
          title: `Could not attach ${name}`,
          description: (error as Error).message
        })
      }
    },
    [patchDraft]
  )

  const attachPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return
      const described = await invoke('composer:describe-paths', cwd, paths)
      const mentionList = described
        .filter((entry) => !entry.isImage)
        .map((entry) => mentionText(entry.mention))
      if (mentionList.length) insertAtCaret(`${mentionList.join(' ')} `)
      for (const image of described.filter((entry) => entry.isImage)) {
        void addImage(image.name, async () => {
          const file = await invoke('composer:read-image', image.path)
          return base64ToBlob(file.data, file.mimeType)
        })
      }
    },
    [cwd, insertAtCaret, addImage]
  )

  const attachFiles = useCallback(
    (files: File[]) => {
      const paths: string[] = []
      for (const file of files) {
        if (isImageFile(file)) void addImage(file.name || 'Pasted image', async () => file)
        else {
          const path = window.vengeance.pathForFile(file)
          if (path) paths.push(path)
        }
      }
      void attachPaths(paths).catch((error: Error) =>
        toast({ level: 'error', title: 'Could not add files', description: error.message })
      )
    },
    [addImage, attachPaths]
  )

  const pickAttachments = async () => {
    try {
      const paths = await invoke('sys:pick-files', {
        title: 'Attach images or files',
        defaultPath: cwd || undefined
      })
      await attachPaths(paths)
    } catch (error) {
      toast({ level: 'error', title: 'Could not add files', description: (error as Error).message })
    }
  }

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      attachFiles([...(event.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [attachFiles])

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    event.preventDefault()
    attachFiles(files)
  }

  return { dragging, onPaste, pickAttachments }
}
