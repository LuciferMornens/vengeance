/**
 * Lazy Shiki syntax highlighting (code blocks, tool previews, diffs).
 *
 * A worker loads Shiki and its grammars on demand, keeping first-language compilation and tokenization
 * off the renderer's input thread. Colors use CSS variables (`--syn-*` in markdown.css), so one
 * tokenization serves both Obsidian (dark) and Bone (light) and theme switches never re-highlight.
 */
import { useEffect, useState } from 'react'
import type { HighlightRequest, HighlightResponse } from './highlight-worker'

/**
 * A run of equally styled code. `className` holds the `syn-*` classes from markdown.css; undefined means
 * the default code color, rendered as a bare text node.
 */
export interface CodeToken {
  content: string
  className?: string
}

export type HighlightedLines = CodeToken[][]

const GRAMMARS = new Set([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'jsonc',
  'shellscript',
  'powershell',
  'bat',
  'python',
  'rust',
  'go',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'css',
  'scss',
  'html',
  'xml',
  'vue',
  'svelte',
  'yaml',
  'toml',
  'ini',
  'dotenv',
  'markdown',
  'sql',
  'graphql',
  'diff',
  'docker',
  'make',
  'ruby',
  'php',
  'lua'
])

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  console: 'shellscript',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  cmd: 'bat',
  batch: 'bat',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  h: 'c',
  'c++': 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  htm: 'html',
  svg: 'xml',
  yml: 'yaml',
  env: 'dotenv',
  md: 'markdown',
  mdx: 'markdown',
  gql: 'graphql',
  patch: 'diff',
  dockerfile: 'docker',
  makefile: 'make',
  rb: 'ruby',
  json5: 'jsonc'
}

/** Canonical grammar id for a fence label / alias, or null when we have no grammar for it. */
export function resolveLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null
  const key = lang.toLowerCase().trim()
  const id = ALIASES[key] ?? key
  return GRAMMARS.has(id) ? id : null
}

const EXTENSION_LANGS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'jsonc',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  env: 'dotenv',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  rb: 'ruby',
  php: 'php',
  lua: 'lua'
}

/** Grammar id for a file path (by extension / well-known file name). */
export function languageFromPath(path: string | undefined): string | null {
  if (!path) return null
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'docker'
  if (name === 'makefile') return 'make'
  if (name.startsWith('.env')) return 'dotenv'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return EXTENSION_LANGS[ext] ?? null
}

/** Short display label for a language id (code block headers, file chips). */
export function languageLabel(lang: string | null | undefined): string {
  const id = resolveLanguage(lang) ?? lang?.toLowerCase() ?? ''
  const labels: Record<string, string> = {
    typescript: 'TypeScript',
    tsx: 'TSX',
    javascript: 'JavaScript',
    jsx: 'JSX',
    json: 'JSON',
    jsonc: 'JSONC',
    shellscript: 'Shell',
    powershell: 'PowerShell',
    bat: 'Batch',
    python: 'Python',
    rust: 'Rust',
    go: 'Go',
    java: 'Java',
    kotlin: 'Kotlin',
    swift: 'Swift',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    css: 'CSS',
    scss: 'SCSS',
    html: 'HTML',
    xml: 'XML',
    vue: 'Vue',
    svelte: 'Svelte',
    yaml: 'YAML',
    toml: 'TOML',
    ini: 'INI',
    dotenv: '.env',
    markdown: 'Markdown',
    sql: 'SQL',
    graphql: 'GraphQL',
    diff: 'Diff',
    docker: 'Dockerfile',
    make: 'Makefile',
    ruby: 'Ruby',
    php: 'PHP',
    lua: 'Lua'
  }
  return labels[id] ?? (id ? id : 'Text')
}

/** Above this size highlighting is skipped (plain text renders instantly). */
const MAX_HIGHLIGHT_CHARS = 120_000
const CACHE_LIMIT = 400
const CACHE_BYTE_BUDGET = 8 * 1024 * 1024
// Token objects carry offsets, styles and references in addition to their text.
const ESTIMATED_TOKEN_BYTES = 96
const ESTIMATED_LINE_BYTES = 32
const UTF16_BYTES = 2
const WORKER_IDLE_MS = 30_000
const HIGHLIGHT_TIMEOUT_MS = 30_000

interface WorkerRequest {
  resolve: (lines: HighlightedLines | null) => void
  timeout: ReturnType<typeof setTimeout>
}

let highlightWorker: Worker | null = null
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null
let nextRequestId = 0
const workerRequests = new Map<number, WorkerRequest>()

const cache = new Map<string, { lines: HighlightedLines; bytes: number }>()
const pendingHighlights = new Map<string, Promise<HighlightedLines | null>>()
let cacheBytes = 0

function stopHighlightWorker(): void {
  if (workerIdleTimer !== null) clearTimeout(workerIdleTimer)
  workerIdleTimer = null
  highlightWorker?.terminate()
  highlightWorker = null
  for (const request of workerRequests.values()) {
    clearTimeout(request.timeout)
    request.resolve(null)
  }
  workerRequests.clear()
}

function getHighlightWorker(): Worker {
  if (workerIdleTimer !== null) clearTimeout(workerIdleTimer)
  workerIdleTimer = null
  if (highlightWorker) return highlightWorker
  const worker = new Worker(new URL('./highlight-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }: MessageEvent<HighlightResponse>) => {
    if (highlightWorker !== worker) return
    const request = workerRequests.get(data.id)
    if (!request) return
    clearTimeout(request.timeout)
    workerRequests.delete(data.id)
    request.resolve(data.lines)
    if (workerRequests.size === 0) {
      workerIdleTimer = setTimeout(stopHighlightWorker, WORKER_IDLE_MS)
    }
  }
  worker.onerror = (event) => {
    event.preventDefault()
    if (highlightWorker === worker) stopHighlightWorker()
  }
  worker.onmessageerror = () => {
    if (highlightWorker === worker) stopHighlightWorker()
  }
  highlightWorker = worker
  return worker
}

function requestHighlight(code: string, language: string): Promise<HighlightedLines | null> {
  return new Promise((resolve) => {
    let worker: Worker
    try {
      worker = getHighlightWorker()
    } catch {
      resolve(null)
      return
    }
    const id = ++nextRequestId
    workerRequests.set(id, {
      resolve,
      timeout: setTimeout(stopHighlightWorker, HIGHLIGHT_TIMEOUT_MS)
    })
    try {
      worker.postMessage({ id, code, language } satisfies HighlightRequest)
    } catch {
      stopHighlightWorker()
    }
  })
}

import.meta.hot?.dispose(stopHighlightWorker)

function cachedHighlight(key: string): HighlightedLines | null {
  const cached = cache.get(key)
  if (!cached) return null
  cache.delete(key)
  cache.set(key, cached)
  return cached.lines
}

function cacheHighlight(key: string, lines: HighlightedLines): void {
  const tokens = lines.reduce((count, line) => count + line.length, 0)
  const bytes =
    key.length * UTF16_BYTES + tokens * ESTIMATED_TOKEN_BYTES + lines.length * ESTIMATED_LINE_BYTES
  if (bytes > CACHE_BYTE_BUDGET) return
  while (cache.size >= CACHE_LIMIT || cacheBytes + bytes > CACHE_BYTE_BUDGET) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    cache.delete(oldest[0])
    cacheBytes -= oldest[1].bytes
  }
  cache.set(key, { lines, bytes })
  cacheBytes += bytes
}

function cacheKey(code: string, lang: string): string {
  return `${lang}\u0000${code}`
}

/** Synchronous cache lookup (lets remounted views render highlighted on the first frame). */
export function peekHighlight(code: string, lang: string | null): HighlightedLines | null {
  const id = resolveLanguage(lang)
  return id ? cachedHighlight(cacheKey(code, id)) : null
}

/** Tokenize `code` (null when the language is unknown, the code is huge, or loading failed). */
export async function highlightCode(
  code: string,
  lang: string | null
): Promise<HighlightedLines | null> {
  const id = resolveLanguage(lang)
  if (!id || code.length > MAX_HIGHLIGHT_CHARS) return null
  const key = cacheKey(code, id)
  const hit = cachedHighlight(key)
  if (hit) return hit
  const pending = pendingHighlights.get(key)
  if (pending) return pending
  const result = (async () => {
    try {
      const lines = await requestHighlight(code, id)
      if (lines) cacheHighlight(key, lines)
      return lines
    } catch {
      return null
    } finally {
      pendingHighlights.delete(key)
    }
  })()
  pendingHighlights.set(key, result)
  return result
}

/**
 * Highlighted tokens for `code`, or null until ready / when disabled. Pass `enabled = false` while the code
 * is still streaming so partial content never triggers a re-highlight storm.
 */
export function useHighlight(
  code: string,
  lang: string | null,
  enabled = true
): HighlightedLines | null {
  const [state, setState] = useState<{
    code: string
    lang: string | null
    lines: HighlightedLines | null
  }>(() => ({
    code,
    lang,
    lines: enabled ? peekHighlight(code, lang) : null
  }))
  useEffect(() => {
    if (!enabled) return
    const cached = peekHighlight(code, lang)
    if (cached) {
      setState({ code, lang, lines: cached })
      return
    }
    let alive = true
    void highlightCode(code, lang).then((lines) => {
      if (alive) setState({ code, lang, lines })
    })
    return () => {
      alive = false
    }
  }, [code, lang, enabled])
  if (!enabled) return null
  return state.code === code && state.lang === lang ? state.lines : peekHighlight(code, lang)
}
