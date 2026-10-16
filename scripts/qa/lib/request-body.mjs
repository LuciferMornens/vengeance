import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate, zstdDecompress } from 'node:zlib'

const decompressors = {
  br: promisify(brotliDecompress),
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  zstd: promisify(zstdDecompress)
}

/** Native Codex transports compress their JSON request bodies. */
export async function readRequestText(incoming) {
  const chunks = []
  for await (const chunk of incoming) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  const encoding = incoming.headers['content-encoding']
  if (!encoding || encoding === 'identity') return bytes.toString('utf8')
  const decompress = decompressors[encoding]
  if (!decompress) throw new Error(`Unsupported request encoding: ${encoding}`)
  return (await decompress(bytes)).toString('utf8')
}
