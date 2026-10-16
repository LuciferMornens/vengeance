import { basename, dirname, extname } from 'node:path'
import type { ResourceType } from '@shared/api/settings'
import { packageLabel } from './package-source'
import type { ResolvedResource } from './pi-modules'

/** Labels for Settings → Resources: one per resource, one per group of resources. */

/**
 * What the user types or picks: skill folder names, prompt templates without `.md` (the UI adds the
 * slash), theme names without `.json`. Extensions keep their file name; that is how they are identified.
 */
export function resourceDisplayName(resource: ResolvedResource, type: ResourceType): string {
  const { path, metadata } = resource
  if (metadata.source === 'builtin') return path.replace(/^builtin:/, '')
  const file = basename(path)
  const parent = basename(dirname(path))
  if (type === 'extensions') return parent === 'extensions' ? file : `${parent}/${file}`
  if (type === 'skills' && file === 'SKILL.md') return parent
  if (type === 'prompts' || type === 'themes') return basename(file, extname(file))
  return file
}

/** The Agent Skills folder (`~/.agents/skills`, or `.agents/skills` in a project) has `.agents` as its base. */
function isAgentsFolder(baseDir: string | undefined): boolean {
  return !!baseDir && basename(baseDir) === '.agents'
}

export function resourceGroupLabel(resource: ResolvedResource): string {
  const { metadata } = resource
  if (metadata.origin === 'package') return packageLabel(metadata.source)
  if (metadata.source === 'builtin') return 'Built-in'
  if (metadata.source === 'auto') {
    if (metadata.scope === 'project') return isAgentsFolder(metadata.baseDir) ? 'Project skills (.agents)' : 'Project folder (.pi)'
    return isAgentsFolder(metadata.baseDir) ? 'Personal skills (~/.agents)' : 'Engine folder'
  }
  return metadata.scope === 'project' ? 'Project settings' : 'Global settings'
}
