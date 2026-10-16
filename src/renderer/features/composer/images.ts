import type { ImageAttachment } from './drafts'

/** Longest edge sent to the model; larger images are downscaled. */
const MAX_EDGE = 2048
/** Images under this size (and within MAX_EDGE) are sent untouched. */
const KEEP_BYTES = 1_500_000
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

let counter = 0
export function attachmentId(): string {
  counter += 1
  return `img-${Date.now().toString(36)}-${counter}`
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'))
    reader.readAsDataURL(blob)
  })
}

export function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

/**
 * Decode an image and make it model-friendly: keep small images byte-for-byte, otherwise downscale to
 * MAX_EDGE and re-encode (PNG when it stays small, else JPEG on a white matte).
 */
export async function prepareImage(blob: Blob, name: string, id = attachmentId()): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(blob)
  try {
    const { width, height } = bitmap
    const longest = Math.max(width, height)
    if (SENDABLE.has(blob.type) && blob.size <= KEEP_BYTES && longest <= MAX_EDGE) {
      return { id, name, mimeType: blob.type, data: await blobToBase64(blob), width, height, bytes: blob.size }
    }
    const scale = Math.min(1, MAX_EDGE / longest)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    let out = await canvas.convertToBlob({ type: 'image/png' })
    if (out.size > KEEP_BYTES) {
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
    }
    return { id, name, mimeType: out.type, data: await blobToBase64(out), width: w, height: h, bytes: out.size }
  } finally {
    bitmap.close()
  }
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}
