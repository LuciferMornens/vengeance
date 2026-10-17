import type { GalleryPackage, GalleryPackageDetail } from '@shared/api/gallery'
import { friendlyExtensionName } from '@shared/display-names'

/** Deterministic gallery for VENGEANCE_MOCK screenshots; four entries match the mock agent dir's installs. */

function entry(
  name: string,
  version: string,
  description: string,
  publisher: string,
  weeklyDownloads: number,
  updated: string,
  keywords: string[]
): GalleryPackage {
  return {
    name,
    displayName: friendlyExtensionName(`npm:${name}`),
    version,
    description,
    publisher,
    license: 'MIT',
    updated,
    weeklyDownloads,
    keywords,
    repository: `https://github.com/${publisher}/${name.replace(/^@[^/]+\//, '')}`,
    npmUrl: `https://www.npmjs.com/package/${name}`
  }
}

export const MOCK_GALLERY: GalleryPackage[] = [
  entry('pi-web-access', '0.9.4', 'Web search, page fetching and a research curator for the agent', 'aurora-labs', 182_400, '2026-10-14T09:12:00.000Z', ['web', 'search', 'research']),
  entry('pi-mcp-bridge', '5.3.1', 'Connect any Model Context Protocol server and expose its tools to the agent', 'toolsmith', 359_600, '2026-10-15T13:47:00.000Z', ['mcp', 'tools']),
  entry('pi-subagents', '2.3.1', 'Delegate focused tasks to parallel subagents with their own context', 'aurora-labs', 96_150, '2026-10-12T18:30:00.000Z', ['subagents', 'parallel']),
  entry('pi-memory-bank', '1.8.0', 'Long-term project memory the agent reads and curates between sessions', 'recall-dev', 41_270, '2026-10-09T07:05:00.000Z', ['memory', 'context']),
  entry('@juicesharp/rpiv-todo', '1.4.0', 'A live todo list the agent keeps while it works', 'juicesharp', 28_930, '2026-10-02T11:44:00.000Z', ['todo', 'planning']),
  entry('pi-git-guard', '0.12.3', 'Checkpoints before risky edits and one-click rollback of the agent’s changes', 'safeharbor', 22_480, '2026-10-16T21:15:00.000Z', ['git', 'safety']),
  entry('pi-lens', '0.6.2', 'LSP diagnostics and code-health dashboards inside sessions', 'lensworks', 17_605, '2026-09-28T16:20:00.000Z', ['lsp', 'diagnostics']),
  entry('pi-browser-pilot', '0.4.0', 'Drive a headless browser to test pages, read docs and capture screenshots', 'pilot-team', 12_340, '2026-10-11T10:00:00.000Z', ['browser', 'testing']),
  entry('pi-review-kit', '3.0.2', 'Prompt templates and a skill for thorough pull request reviews', 'codecraft', 9_870, '2026-10-07T08:30:00.000Z', ['review', 'prompts']),
  entry('pi-theme-nocturne', '1.1.0', 'Nocturne, Ember Dusk and Paper themes for the terminal interface', 'studio-nine', 4_215, '2026-08-30T12:00:00.000Z', ['theme']),
  entry('pi-sql-scout', '0.9.1', 'Inspect database schemas and run read-only queries from the agent', 'datafold', 3_980, '2026-10-01T14:40:00.000Z', ['sql', 'database']),
  entry('pi-voice-notes', '0.3.5', 'Dictate prompts and get spoken summaries of finished runs', 'hushlabs', 1_105, '2026-09-19T19:25:00.000Z', ['voice', 'accessibility'])
]

export function mockDetail(name: string): GalleryPackageDetail {
  const pkg = MOCK_GALLERY.find((candidate) => candidate.name === name)
  if (!pkg) throw new Error('This package is no longer published.')
  const theme = pkg.keywords.includes('theme')
  const prompts = pkg.keywords.includes('prompts')
  return {
    name,
    version: pkg.version,
    resources: {
      extensions: !theme && !prompts,
      skills: prompts || name === 'pi-memory-bank',
      prompts,
      themes: theme
    },
    dependencies: theme ? 0 : 4,
    unpackedSize: theme ? 48_200 : 1_284_000
  }
}
