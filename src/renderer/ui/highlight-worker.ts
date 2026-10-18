import type {
  HighlighterCore,
  LanguageRegistration,
  ThemeRegistration,
  ThemedToken
} from 'shiki/core'
import type { CodeToken, HighlightedLines } from './highlight'

export interface HighlightRequest {
  id: number
  code: string
  language: string
}

export interface HighlightResponse {
  id: number
  lines: HighlightedLines | null
}

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

const syntaxRule = (scope: string | string[], foreground: string, fontStyle?: string) => ({
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
    syntaxRule(
      ['comment', 'punctuation.definition.comment', 'string.comment'],
      'var(--syn-comment)',
      'italic'
    ),
    syntaxRule(
      [
        'punctuation',
        'meta.brace',
        'keyword.operator',
        'punctuation.separator',
        'punctuation.terminator'
      ],
      'var(--syn-punct)'
    ),
    syntaxRule(
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
    syntaxRule(
      [
        'string',
        'string.quoted',
        'string.template',
        'punctuation.definition.string',
        'string.unquoted.plain'
      ],
      'var(--syn-string)'
    ),
    syntaxRule(
      ['string.regexp', 'constant.other.character-class.regexp', 'constant.character.escape'],
      'var(--syn-regex)'
    ),
    syntaxRule(
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
    syntaxRule(
      ['variable.other.constant', 'variable.other.enummember', 'entity.name.constant'],
      'var(--syn-constant)'
    ),
    syntaxRule(
      [
        'entity.name.function',
        'support.function',
        'meta.function-call entity.name.function',
        'variable.function',
        'entity.name.method'
      ],
      'var(--syn-function)'
    ),
    syntaxRule(
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
    syntaxRule(['variable.parameter', 'meta.parameter variable'], 'var(--syn-param)'),
    syntaxRule(
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
    syntaxRule(['entity.name.tag', 'punctuation.definition.tag'], 'var(--syn-tag)'),
    syntaxRule(
      [
        'entity.other.attribute-name',
        'entity.other.attribute-name.id',
        'entity.other.attribute-name.class'
      ],
      'var(--syn-attr)'
    ),
    syntaxRule(
      ['support.type.property-name.css', 'support.type.vendored.property-name'],
      'var(--syn-property)'
    ),
    syntaxRule(
      ['markup.heading', 'entity.name.section', 'markup.heading punctuation.definition.heading'],
      'var(--syn-keyword)',
      'bold'
    ),
    syntaxRule(['markup.bold'], 'var(--syn-fg)', 'bold'),
    syntaxRule(['markup.italic'], 'var(--syn-fg)', 'italic'),
    syntaxRule(['markup.inline.raw', 'markup.fenced_code'], 'var(--syn-string)'),
    syntaxRule(['markup.underline.link', 'string.other.link'], 'var(--syn-function)'),
    syntaxRule(['markup.inserted', 'punctuation.definition.inserted'], 'var(--syn-inserted)'),
    syntaxRule(['markup.deleted', 'punctuation.definition.deleted'], 'var(--syn-deleted)'),
    syntaxRule(
      ['meta.diff.header', 'meta.diff.range', 'punctuation.definition.range.diff'],
      'var(--syn-comment)'
    ),
    syntaxRule(
      ['variable.other.readwrite', 'variable', 'meta.definition.variable'],
      'var(--syn-fg)'
    ),
    syntaxRule(['support.variable', 'variable.other.object'], 'var(--syn-fg)'),
    syntaxRule(
      ['entity.name.function.decorator', 'meta.decorator', 'punctuation.decorator'],
      'var(--syn-attr)'
    )
  ]
}

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Map<string, Promise<void>>()

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

async function tokenize(code: string, language: string): Promise<HighlightedLines | null> {
  try {
    const highlighter = await getHighlighter()
    await ensureLanguage(highlighter, language)
    return highlighter
      .codeToTokensBase(code, { lang: language, theme: 'vengeance' })
      .map(codeTokens)
  } catch {
    return null
  }
}

globalThis.addEventListener('message', (event: MessageEvent<HighlightRequest>) => {
  const { id, code, language } = event.data
  void tokenize(code, language).then((lines) => {
    globalThis.postMessage({ id, lines } satisfies HighlightResponse)
  })
})
