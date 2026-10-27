import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate, zstdDecompress } from 'node:zlib'

const brotli = promisify(brotliDecompress)
const gzip = promisify(gunzip)
const deflate = promisify(inflate)
const zstd = promisify(zstdDecompress)

function decompress(encoding, bytes) {
  switch (encoding) {
    case 'br':
      return brotli(bytes)
    case 'gzip':
      return gzip(bytes)
    case 'deflate':
      return deflate(bytes)
    case 'zstd':
      return zstd(bytes)
    default:
      throw new Error(`Unsupported request encoding: ${encoding}`)
  }
}

/** Native Codex transports compress their JSON request bodies. */
export async function readRequestText(incoming) {
  const chunks = []
  for await (const chunk of incoming) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  const encoding = incoming.headers['content-encoding']
  if (!encoding || encoding === 'identity') return bytes.toString('utf8')
  return (await decompress(encoding, bytes)).toString('utf8')
}
