import { readJsonFile } from './json-file'
import { listResources } from './packages'

/**
 * Custom themes an engine started in `cwd` loads. pi registers a theme under the `name` inside its JSON file, not
 * the file name, and that name is what the `theme` setting refers to.
 */
export async function installedThemeNames(override: string | null, cwd: string | null): Promise<string[]> {
  const names = new Set<string>()
  for (const group of await listResources(override, cwd)) {
    for (const item of group.items) {
      if (item.type !== 'themes' || !item.enabled) continue
      const name = readJsonFile(item.path).data.name
      if (typeof name === 'string' && name.trim()) names.add(name)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
