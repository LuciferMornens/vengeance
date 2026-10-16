import { sdkHostCall } from '../../engine/sdk-host/client'
import type { PackageScope } from '../../engine/sdk-host/protocol'

/** The latest version of an npm package, asked from the registry the user's npm is configured for. */

const NPMJS_REGISTRY_HOST = 'registry.npmjs.org'

export interface NpmRelease {
  version?: string
  /** Host that serves the tarball: tells the public npm registry apart from a mirror or private one. */
  registryHost?: string
}

/** Parse `npm view <name> version dist.tarball --json`. */
export function parseNpmView(stdout: string): NpmRelease {
  try {
    const data: unknown = JSON.parse(stdout)
    if (typeof data === 'string') return { version: data }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const fields = data as Record<string, unknown>
    const tarball = fields['dist.tarball']
    return {
      version: typeof fields.version === 'string' ? fields.version : undefined,
      registryHost: typeof tarball === 'string' && URL.canParse(tarball) ? new URL(tarball).host : undefined
    }
  } catch {
    return {}
  }
}

/**
 * Asked through the engine package manager's own npm runner (in the SDK host): it is what `pi update` runs, so the
 * `npmCommand` setting and the user's npm config (registry, scoped registries) apply.
 */
export async function latestNpmRelease(override: string | null, scope: PackageScope, name: string): Promise<NpmRelease> {
  try {
    const stdout = await sdkHostCall(override, 'npm-view', { ...scope, name })
    return stdout === null ? {} : parseNpmView(stdout)
  } catch {
    return {}
  }
}

/** The npmjs.com versions page, only for packages served by the public registry. */
export function npmChangelogUrl(name: string, release: NpmRelease): string | undefined {
  return release.registryHost === NPMJS_REGISTRY_HOST ? `https://www.npmjs.com/package/${name}?activeTab=versions` : undefined
}
