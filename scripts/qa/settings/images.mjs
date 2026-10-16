// Tiny image fixtures for the settings suites: a solid-color PNG of any size, and the pixel size of a
// base64 PNG or JPEG as the Engine sent it to the model.
import { crc32, deflateSync } from 'node:zlib'

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A solid RGB PNG, `width` × `height`, as base64. */
export function solidPngBase64(width, height, rgb = [200, 40, 40]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit, truecolor, deflate, no filter, no interlace
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}

/** `{ width, height }` of a base64 PNG or JPEG, or null for anything else. */
export function imageSize(base64) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset < bytes.length) {
      const marker = bytes[offset + 1]
      const length = bytes.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return null
}

/** Base64 data of every image block in an anthropic-messages request body. */
export function anthropicImages(body) {
  const found = []
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      if (value.type === 'image' && value.source?.data) found.push(value.source.data)
      else Object.values(value).forEach(visit)
    }
  }
  visit(body?.messages)
  return found
}
