import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { EngineId } from '@shared/api/engine'

export const ENGINE_UPDATE_MESSAGE =
  'Engine updates are included with Vengeance releases. Update Vengeance to get the latest supported engines.'

export interface BundledEngine {
  version: string
  revision: string
  packageDir: string
  entry: string
  payloadHash: string
}

export function bundledEngine(identity: EngineId): BundledEngine {
  const directory = process.env.VENGEANCE_BUNDLED_ENGINES
    ? resolve(process.env.VENGEANCE_BUNDLED_ENGINES)
    : process.resourcesPath && !process.defaultApp
      ? join(process.resourcesPath, 'engines')
      : resolve(__dirname, '../../.engine-staging/bundled')
  try {
    // The release builder verifies the complete payload; startup validates its manifest and entries.
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      schemaVersion?: number
      platform?: string
      engines?: Partial<Record<EngineId, Partial<BundledEngine>>>
    }
    const engine = manifest.engines?.[identity]
    if (
      manifest.schemaVersion !== 1 ||
      manifest.platform !== `${process.platform}-${process.arch}` ||
      !engine ||
      typeof engine.version !== 'string' ||
      typeof engine.revision !== 'string' ||
      typeof engine.payloadHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(engine.payloadHash)
    ) {
      throw new Error('Invalid engine manifest')
    }
    const paths = [engine.packageDir, engine.entry].map((path) => {
      if (typeof path !== 'string' || isAbsolute(path)) throw new Error('Invalid engine path')
      const target = resolve(directory, path)
      const inside = relative(directory, target)
      if (!inside || inside.startsWith('..') || isAbsolute(inside) || !existsSync(target)) {
        throw new Error('Missing engine files')
      }
      return target
    })
    return {
      version: engine.version,
      revision: engine.revision,
      packageDir: paths[0]!,
      entry: paths[1]!,
      payloadHash: engine.payloadHash
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const repair =
      process.resourcesPath && !process.defaultApp
        ? 'Reinstall Vengeance.'
        : 'Run npm run build:engines.'
    throw new Error(
      `The bundled ${identity === 'pi' ? 'Engine' : 'Engine 2'} is unavailable. ${repair} ${detail}`
    )
  }
}
