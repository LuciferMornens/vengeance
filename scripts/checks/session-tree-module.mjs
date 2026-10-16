// Loads src/main/engine/session-tree.ts into a plain Node script (bundled with esbuild, like run.mjs does
// for the offline checks), so the real-engine checks compare the engine against the same tree builder.
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `{ flattenSessionTree, sessionTreeFromEntries, … }` of src/main/engine/session-tree.ts. */
export async function loadSessionTreeModule() {
  const cache = join(root, 'node_modules', '.cache', 'vengeance-real-checks')
  await mkdir(cache, { recursive: true })
  const outfile = join(cache, 'session-tree.mjs')
  await build({
    entryPoints: [join(root, 'src', 'main', 'engine', 'session-tree.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    alias: { '@shared': join(root, 'src', 'shared') },
    logLevel: 'warning'
  })
  return import(pathToFileURL(outfile).href)
}
