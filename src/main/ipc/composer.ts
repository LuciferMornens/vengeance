import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ComposerPathInfo } from '@shared/api/composer'
import { readCommandHints } from '../features/composer/command-hints'
import type { IpcContext } from './context'
import { handle } from './handle'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** Workspace-relative (forward slashes) when inside `cwd`, otherwise the absolute path. */
function mentionFor(cwd: string, path: string): string {
  const rel = relative(resolve(cwd), resolve(path))
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  return inside ? rel.split(sep).join('/') : resolve(path)
}

async function describe(cwd: string, path: string): Promise<ComposerPathInfo | null> {
  try {
    const info = await stat(path)
    return {
      path,
      name: basename(path),
      mention: mentionFor(cwd, path),
      isDirectory: info.isDirectory(),
      isImage: info.isFile() && extname(path).toLowerCase() in IMAGE_TYPES,
      size: info.size
    }
  } catch {
    return null
  }
}

/** Composer main-process handlers: dropped/picked paths, image attachments, command hints. */
export function registerComposerIpc(_context: IpcContext): void {
  handle('composer:describe-paths', async (cwd, paths) => {
    const described = await Promise.all(paths.map((path) => describe(cwd, path)))
    return described.filter((item): item is ComposerPathInfo => item !== null)
  })

  handle('composer:read-image', async (path) => {
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()]
    if (!mimeType) throw new Error(`Not a supported image: ${basename(path)}`)
    const info = await stat(path)
    if (info.size > MAX_IMAGE_BYTES) throw new Error(`${basename(path)} is larger than 32 MB`)
    const bytes = await readFile(path)
    return { name: basename(path), mimeType, data: bytes.toString('base64'), size: info.size }
  })

  handle('composer:command-hints', (cwd, paths) => readCommandHints(cwd, paths))
}
