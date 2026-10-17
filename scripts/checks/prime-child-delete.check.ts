import { strict as assert } from 'node:assert'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { SessionLineage } from '../../src/shared/api/sessions'
import { check } from './harness'

interface DeleteApi {
  deletePrimeChildSession(
    path: string,
    sessionId: string,
    lineage: SessionLineage,
    roots: string[]
  ): Promise<void>
}

interface DeleteRequest {
  path: string
  parentPath: string
  childId: string
  recoveryPath: string
}

await check(
  'Prime child Delete retains recoverable history on native and Recycle Bin failures',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vengeance-child-delete-'))
    const source = join(directory, 'child.jsonl')
    const parent = join(directory, 'parent.jsonl')
    const history = 'A child conversation that must remain recoverable.'
    let nativeFailure = false
    let recycleFailure = false
    let resident: 'none' | 'running' | 'settled' = 'none'
    let recoveryPath = ''
    let closed = 0
    const recycled: string[] = []
    const esbuild: typeof import('esbuild') = createRequire(join(process.cwd(), 'package.json'))(
      'esbuild'
    )
    const built = await esbuild.build({
      stdin: {
        contents:
          "export { deletePrimeChildSession } from './src/main/engine/prime/session-delete'",
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      plugins: [
        {
          name: 'child-delete-native-boundaries',
          setup(build) {
            build.onResolve(
              { filter: /(?:^electron$|\/daemon$|\/locate$|\/sessions-native$)/ },
              ({ path }) => ({ path, namespace: 'fixture' })
            )
            build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
              contents:
                path === 'electron'
                  ? `export const app = { getPath: () => globalThis.directory };
                  export const shell = { trashItem: globalThis.trash };`
                  : path.endsWith('/locate')
                    ? 'export const getPrimeAgentDir = () => globalThis.directory;'
                    : path.endsWith('/daemon')
                      ? 'export const connectPrimeResident = globalThis.resident;'
                      : 'export const nativePrimeDeleteChild = globalThis.removeNative;',
              loader: 'js'
            }))
          }
        }
      ]
    })
    const module = { exports: {} as DeleteApi }
    runInNewContext(built.outputFiles[0]!.text, {
      module,
      exports: module.exports,
      require: createRequire(join(process.cwd(), 'package.json')),
      directory,
      removeNative: async (request: DeleteRequest) => {
        assert.equal(request.parentPath, parent)
        assert.equal(request.childId, 'sub-child')
        recoveryPath = request.recoveryPath
        await copyFile(request.path, request.recoveryPath)
        await rm(request.path)
        if (nativeFailure) throw new Error('Native tombstone could not be written')
      },
      resident: async () =>
        resident === 'none'
          ? null
          : {
              nativeAgentId: 'native-parent',
              client: {
                request: async (command: string, request: { childId: string }) => {
                  assert.equal(command, 'delete_rlm_subagent')
                  assert.equal(request.childId, 'sub-child')
                  if (resident === 'running') return { deleted: false, reason: 'running' }
                  await rm(source)
                  return { deleted: true }
                },
                close: () => {
                  closed++
                }
              }
            },
      trash: async (path: string) => {
        if (recycleFailure) throw new Error('Recycle Bin unavailable')
        recycled.push(await readFile(path, 'utf8'))
        await rm(path)
      }
    })
    const remove = () =>
      module.exports.deletePrimeChildSession(
        source,
        'child',
        {
          childId: 'sub-child',
          parentSessionPath: parent,
          depth: 1
        },
        [directory]
      )
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(source, history)
      await remove()
      assert.equal(recycled.at(-1), history)
      await assert.rejects(stat(source), { code: 'ENOENT' })

      await writeFile(source, history)
      nativeFailure = true
      await assert.rejects(remove(), /Recovery copy:/)
      assert.equal(await readFile(recoveryPath, 'utf8'), history)
      await rm(recoveryPath)

      await writeFile(source, history)
      nativeFailure = false
      recycleFailure = true
      await assert.rejects(remove(), /Recovery copy:/)
      assert.equal(await readFile(recoveryPath, 'utf8'), history)
      await rm(recoveryPath)

      await writeFile(source, history)
      recycleFailure = false
      resident = 'running'
      await assert.rejects(remove(), /Stop the child/)
      assert.equal(await readFile(source, 'utf8'), history)
      resident = 'settled'
      await remove()
      assert.equal(recycled.at(-1), history)
      assert.equal(closed, 2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
