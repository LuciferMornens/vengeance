/**
 * Extension gallery: community Engine packages published to npm with the `pi-package` keyword (the index
 * behind the public package gallery). Read-only discovery; installing goes through `settings:package-run`.
 */

export interface GalleryPackage {
  /** npm package name, e.g. `pi-web-access` or `@scope/name`. */
  name: string
  /** Human label (`friendlyExtensionName`), e.g. "Web access". */
  displayName: string
  version: string
  description?: string
  publisher?: string
  license?: string
  /** ISO date of the latest publish. */
  updated?: string
  weeklyDownloads?: number
  keywords: string[]
  /** https links only. */
  homepage?: string
  repository?: string
  npmUrl: string
}

export interface GallerySearchArgs {
  /** Free text; empty lists the most popular packages. */
  query: string
  /** Offset for the next page. */
  from?: number
}

export interface GallerySearchResult {
  query: string
  from: number
  total: number
  packages: GalleryPackage[]
}

/** What the latest published manifest declares. Unknown counts mean the package uses conventional folders. */
export interface GalleryPackageDetail {
  name: string
  version: string
  /** Resource kinds the `pi` manifest declares; null when the package relies on conventional folders. */
  resources: { extensions: boolean; skills: boolean; prompts: boolean; themes: boolean } | null
  dependencies: number
  unpackedSize?: number
  /** https preview media declared by the package (`pi.image` / `pi.video`), opened externally. */
  preview?: string
}

export interface GalleryInvokeMap {
  'gallery:search': [args: GallerySearchArgs, result: GallerySearchResult]
  'gallery:package': [name: string, result: GalleryPackageDetail]
}

export const GALLERY_PAGE_SIZE = 24
export const GALLERY_URL = 'https://pi.dev/packages'
