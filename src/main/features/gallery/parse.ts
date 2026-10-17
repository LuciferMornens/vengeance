import type { GalleryPackage, GalleryPackageDetail } from '@shared/api/gallery'
import { friendlyExtensionName } from '@shared/display-names'

/** Pure parsing of npm registry responses for the extension gallery (no Electron, testable offline). */

type Json = Record<string, unknown>

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/

export function isNpmPackageName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name)
}

function record(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
}

function text(value: unknown, max = 400): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** An https URL for links; repository specs like `git+https://…/x.git` become their web page. */
export function webUrl(value: unknown): string | undefined {
  let raw = text(value, 2048)
  if (!raw) return undefined
  raw = raw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://')
  const shorthand = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+)$/.exec(raw)
  if (shorthand) {
    const host = `${shorthand[1]}.${shorthand[1] === 'bitbucket' ? 'org' : 'com'}`
    raw = `https://${host}/${shorthand[2]}`
  }
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password) return undefined
  url.pathname = url.pathname.replace(/\.git$/, '')
  return url.toString()
}

/** One `objects[]` entry of `/-/v1/search`; null for anything that is not a usable package. */
export function parseSearchObject(value: unknown): GalleryPackage | null {
  const entry = record(value)
  const pkg = record(entry?.package)
  const name = text(pkg?.name, 214)
  const version = text(pkg?.version, 64)
  if (!pkg || !name || !version || !isNpmPackageName(name)) return null
  const links = record(pkg.links)
  const keywords = Array.isArray(pkg.keywords)
    ? pkg.keywords.flatMap((keyword) => {
        const value = text(keyword, 40)
        return value && value !== 'pi-package' ? [value.toLowerCase()] : []
      })
    : []
  return {
    name,
    displayName: friendlyExtensionName(`npm:${name}`),
    version,
    description: text(pkg.description),
    publisher: text(record(pkg.publisher)?.username, 80),
    license: text(pkg.license, 40),
    updated: text(entry?.updated, 40) ?? text(pkg.date, 40),
    weeklyDownloads: count(record(entry?.downloads)?.weekly),
    keywords: [...new Set(keywords)].slice(0, 8),
    homepage: webUrl(links?.homepage),
    repository: webUrl(links?.repository),
    npmUrl: `https://www.npmjs.com/package/${name}`
  }
}

export function parseSearch(value: unknown): { total: number; packages: GalleryPackage[] } {
  const body = record(value)
  const objects = Array.isArray(body?.objects) ? body.objects : []
  const packages = objects.flatMap((object) => parseSearchObject(object) ?? [])
  return { total: count(body?.total) ?? packages.length, packages }
}

/** `/<name>/latest`: what the published manifest declares for the details view. */
export function parseManifest(name: string, value: unknown): GalleryPackageDetail {
  const manifest = record(value)
  const pi = record(manifest?.pi)
  const declared = (key: string) => {
    const entry = pi?.[key]
    return Array.isArray(entry) ? entry.length > 0 : typeof entry === 'string'
  }
  const kinds = ['extensions', 'skills', 'prompts', 'themes'] as const
  const preview = webUrl(pi?.image) ?? webUrl(pi?.video)
  return {
    name,
    version: text(manifest?.version, 64) ?? '',
    resources:
      pi && kinds.some(declared)
        ? {
            extensions: declared('extensions'),
            skills: declared('skills'),
            prompts: declared('prompts'),
            themes: declared('themes')
          }
        : null,
    dependencies: Object.keys(record(manifest?.dependencies) ?? {}).length,
    unpackedSize: count(record(manifest?.dist)?.unpackedSize),
    preview
  }
}
