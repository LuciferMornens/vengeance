/**
 * Lazy Shiki syntax highlighting (code blocks, tool previews, diffs).
 *
 * Shiki, its JavaScript regex engine and every grammar are dynamically imported on first use, so none of
 * it is in the main bundle. Colors are CSS variables (`--syn-*`, defined in markdown.css per theme), so one
 * tokenization serves both Obsidian (dark) and Bone (light) and theme switches never re-highlight.
 */
import { useEffect, useState } from 'react'
import type {
  HighlighterCore,
  LanguageRegistration,
  ThemeRegistration,
  ThemedToken
} from 'shiki/core'

/**
 * A run of equally styled code. `className` holds the `syn-*` classes from markdown.css; undefined means
 * the default code color, rendered as a bare text node.
 */
export interface CodeToken {
  content: string
  className?: string
}

export type HighlightedLines = CodeToken[][]

type GrammarLoader = () => Promise<{ default: LanguageRegistration[] }>

const GRAMMARS: Record<string, GrammarLoader> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  lua: () => import('shiki/langs/lua.mjs')
}

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
  return id in GRAMMARS ? id : null
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

const s = (scope: string | string[], foreground: string, fontStyle?: string) => ({
  scope,
  settings: fontStyle ? { foreground, fontStyle } : { foreground }
})

/** Obsidian & Ember / Bone syntax theme — every color resolves through a CSS variable. */
const THEME: ThemeRegistration = {
  name: 'vengeance',
  type: 'dark',
  fg: 'var(--syn-fg)',
  bg: 'transparent',
  colors: { 'editor.foreground': 'var(--syn-fg)', 'editor.background': 'transparent' },
  tokenColors: [
    s(
      ['comment', 'punctuation.definition.comment', 'string.comment'],
      'var(--syn-comment)',
      'italic'
    ),
    s(
      [
        'punctuation',
        'meta.brace',
        'keyword.operator',
        'punctuation.separator',
        'punctuation.terminator'
      ],
      'var(--syn-punct)'
    ),
    s(
      [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.logical.python',
        'keyword.operator.wordlike',
        'variable.language.this',
        'variable.language.self'
      ],
      'var(--syn-keyword)'
    ),
    s(
      [
        'string',
        'string.quoted',
        'string.template',
        'punctuation.definition.string',
        'string.unquoted.plain'
      ],
      'var(--syn-string)'
    ),
    s(
      ['string.regexp', 'constant.other.character-class.regexp', 'constant.character.escape'],
      'var(--syn-regex)'
    ),
    s(
      [
        'constant.numeric',
        'constant.language',
        'constant.character',
        'support.constant',
        'constant.other.color',
        'keyword.other.unit'
      ],
      'var(--syn-number)'
    ),
    s(
      ['variable.other.constant', 'variable.other.enummember', 'entity.name.constant'],
      'var(--syn-constant)'
    ),
    s(
      [
        'entity.name.function',
        'support.function',
        'meta.function-call entity.name.function',
        'variable.function',
        'entity.name.method'
      ],
      'var(--syn-function)'
    ),
    s(
      [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'support.type',
        'support.class',
        'entity.other.inherited-class',
        'storage.type.primitive',
        'storage.type.built-in',
        'entity.name.type.module'
      ],
      'var(--syn-type)'
    ),
    s(['variable.parameter', 'meta.parameter variable'], 'var(--syn-param)'),
    s(
      [
        'variable.other.property',
        'variable.other.object.property',
        'support.variable.property',
        'meta.object-literal.key',
        'support.type.property-name',
        'entity.name.tag.yaml',
        'support.type.property-name.json'
      ],
      'var(--syn-property)'
    ),
    s(['entity.name.tag', 'punctuation.definition.tag'], 'var(--syn-tag)'),
    s(
      [
        'entity.other.attribute-name',
        'entity.other.attribute-name.id',
        'entity.other.attribute-name.class'
      ],
      'var(--syn-attr)'
    ),
    s(
      ['support.type.property-name.css', 'support.type.vendored.property-name'],
      'var(--syn-property)'
    ),
    s(
      ['markup.heading', 'entity.name.section', 'markup.heading punctuation.definition.heading'],
      'var(--syn-keyword)',
      'bold'
    ),
    s(['markup.bold'], 'var(--syn-fg)', 'bold'),
    s(['markup.italic'], 'var(--syn-fg)', 'italic'),
    s(['markup.inline.raw', 'markup.fenced_code'], 'var(--syn-string)'),
    s(['markup.underline.link', 'string.other.link'], 'var(--syn-function)'),
    s(['markup.inserted', 'punctuation.definition.inserted'], 'var(--syn-inserted)'),
    s(['markup.deleted', 'punctuation.definition.deleted'], 'var(--syn-deleted)'),
    s(
      ['meta.diff.header', 'meta.diff.range', 'punctuation.definition.range.diff'],
      'var(--syn-comment)'
    ),
    s(['variable.other.readwrite', 'variable', 'meta.definition.variable'], 'var(--syn-fg)'),
    s(['support.variable', 'variable.other.object'], 'var(--syn-fg)'),
    s(
      ['entity.name.function.decorator', 'meta.decorator', 'punctuation.decorator'],
      'var(--syn-attr)'
    )
  ]
}

/** Above this size highlighting is skipped (plain text renders instantly). */
const MAX_HIGHLIGHT_CHARS = 120_000
const CACHE_LIMIT = 400
const CACHE_BYTE_BUDGET = 8 * 1024 * 1024
// Token objects carry offsets, styles and references in addition to their text.
const ESTIMATED_TOKEN_BYTES = 96
const ESTIMATED_LINE_BYTES = 32
const UTF16_BYTES = 2

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Map<string, Promise<void>>()
const cache = new Map<string, { lines: HighlightedLines; bytes: number }>()
const pendingHighlights = new Map<string, Promise<HighlightedLines | null>>()
let cacheBytes = 0

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

/** Shiki font style bit flags. */
const FONT_ITALIC = 1
const FONT_BOLD = 2
const FONT_UNDERLINE = 4

const SYNTAX_COLOR = /^var\(--syn-([a-z]+)\)$/

function tokenClass(token: ThemedToken): string | undefined {
  const classes: string[] = []
  const color = token.color ? SYNTAX_COLOR.exec(token.color)?.[1] : undefined
  if (color && color !== 'fg') classes.push(`syn-${color}`)
  const fontStyle = token.fontStyle ?? 0
  if (fontStyle > 0) {
    if (fontStyle & FONT_ITALIC) classes.push('syn-italic')
    if (fontStyle & FONT_BOLD) classes.push('syn-bold')
    if (fontStyle & FONT_UNDERLINE) classes.push('syn-underline')
  }
  return classes.length > 0 ? classes.join(' ') : undefined
}

/** Blank text shows no color, so it can take its neighbor's style unless an underline would show. */
function blendsIn(content: string, className: string | undefined, neighbor: string | undefined) {
  return (
    content.trim() === '' &&
    !className?.includes('syn-underline') &&
    !neighbor?.includes('syn-underline')
  )
}

/**
 * One line of Shiki tokens as the fewest equally styled runs: each run is one element (or text node),
 * about 60% of Shiki's token count for typical code, and every element costs DOM and layout memory.
 */
function codeTokens(line: ThemedToken[]): CodeToken[] {
  const runs: CodeToken[] = []
  for (const token of line) {
    const className = tokenClass(token)
    const last = runs[runs.length - 1]
    if (!last) {
      runs.push({ content: token.content, className })
    } else if (last.className === className || blendsIn(token.content, className, last.className)) {
      last.content += token.content
    } else if (blendsIn(last.content, last.className, className)) {
      last.content += token.content
      last.className = className
    } else {
      runs.push({ content: token.content, className })
    }
  }
  return runs
}

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript')
    ]).then(([core, engine]) =>
      core.createHighlighterCore({
        themes: [THEME],
        langs: [],
        engine: engine.createJavaScriptRegexEngine({ forgiving: true })
      })
    )
    highlighterPromise.catch(() => {
      highlighterPromise = null
    })
  }
  return highlighterPromise
}

function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<void> {
  let pending = loadedLangs.get(lang)
  if (!pending) {
    const loader = GRAMMARS[lang]
    if (!loader) return Promise.reject(new Error(`No grammar for ${lang}`))
    pending = loader().then((mod) => highlighter.loadLanguage(...mod.default))
    pending.catch(() => loadedLangs.delete(lang))
    loadedLangs.set(lang, pending)
  }
  return pending
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
      const highlighter = await getHighlighter()
      await ensureLanguage(highlighter, id)
      const lines = highlighter
        .codeToTokensBase(code, { lang: id, theme: 'vengeance' })
        .map(codeTokens)
      cacheHighlight(key, lines)
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
