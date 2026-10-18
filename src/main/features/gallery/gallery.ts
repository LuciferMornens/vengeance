import { net } from 'electron'
import {
  GALLERY_PAGE_SIZE,
  type GalleryPackageDetail,
  type GallerySearchArgs,
  type GallerySearchResult
} from '@shared/api/gallery'
import { env } from '../../env'
import { updatesOfflineReason } from '../updates/updates-service'
import { isNpmPackageName, parseManifest, parseSearch } from './parse'

/**
 * The extension gallery reads the public npm index of `pi-package` packages. Searches are cached briefly so
 * paging back and forth or reopening the view does not refetch; installs never go through here.
 */

const REGISTRY = 'https://registry.npmjs.org'
const TIMEOUT_MS = 10_000
const CACHE_MS = 5 * 60_000
const CACHE_LIMIT = 40
const MAX_QUERY = 120

const cache = new Map<string, { at: number; value: Promise<unknown> }>()

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>
  const value = load()
  cache.set(key, { at: Date.now(), value })
  // A failed request must not be served from the cache.
  value.catch(() => cache.get(key)?.value === value && cache.delete(key))
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return value
}

function assertOnline(): void {
  const reason = updatesOfflineReason()
  if (reason === 'setting')
    throw new Error('Work offline is on. Turn it off in Settings › Engine to browse extensions.')
  if (reason) throw new Error('You’re offline. Connect to the internet to browse extensions.')
}

async function getJson(url: string): Promise<unknown> {
  const response = await net.fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (response.status === 404) throw new Error('This package is no longer published.')
  if (!response.ok) throw new Error(`The extension gallery answered ${response.status}. Try again shortly.`)
  return response.json()
}

export async function searchGallery({ query, from = 0 }: GallerySearchArgs): Promise<GallerySearchResult> {
  const terms = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY)
  const offset = Number.isInteger(from) && from > 0 ? from : 0
  if (env.mock) {
    const { MOCK_GALLERY } = await import('./mock')
    const needle = terms.toLowerCase()
    const matches = MOCK_GALLERY.filter((pkg) =>
      [pkg.name, pkg.description ?? '', ...pkg.keywords].some((field) =>
        field.toLowerCase().includes(needle)
      )
    )
    return {
      query: terms,
      from: offset,
      total: matches.length,
      packages: matches.slice(offset, offset + GALLERY_PAGE_SIZE)
    }
  }
  assertOnline()
  return cached(`search:${terms.toLowerCase()}:${offset}`, async () => {
    const params = new URLSearchParams({
      text: `keywords:pi-package${terms ? ` ${terms}` : ''}`,
      size: String(GALLERY_PAGE_SIZE),
      from: String(offset)
    })
    const parsed = parseSearch(await getJson(`${REGISTRY}/-/v1/search?${params}`))
    return { query: terms, from: offset, ...parsed }
  })
}

export async function galleryPackage(name: string): Promise<GalleryPackageDetail> {
  if (typeof name !== 'string' || !isNpmPackageName(name)) throw new Error('Choose a package from the gallery')
  if (env.mock) return (await import('./mock')).mockDetail(name)
  assertOnline()
  return cached(`package:${name}`, async () =>
    parseManifest(name, await getJson(`${REGISTRY}/${name.replace('/', '%2F')}/latest`))
  )
}
