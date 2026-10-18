import './markdown.css'
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
  type ReactNode
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check } from 'lucide-react'
import { cn } from '../lib/cn'
import { invoke } from '../lib/ipc'
import { CodeBlock } from './CodeView'
import { CopyButton } from './CopyButton'
import { MarkdownBlockSplitter } from './markdown-blocks'
import { Shimmer } from './Spinner'

const REMARK_PLUGINS = [remarkGfm]
const EXTERNAL = /^(https?:|mailto:)/i

/** Open http(s)/mailto links in the system browser (never navigate the app window). */
export function openExternal(href: string | undefined): void {
  if (href && EXTERNAL.test(href)) void invoke('sys:open-external', href)
}

function Link({ href, children }: ComponentProps<'a'>) {
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault()
        openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

function codeOf(children: ReactNode): { code: string; lang: string | null } {
  const child = (Array.isArray(children) ? children[0] : children) as
    ReactElement<{ className?: string; children?: ReactNode }> | undefined
  const className = child?.props?.className ?? ''
  const lang = /language-([\w+#.-]+)/.exec(className)?.[1] ?? null
  const raw = child?.props?.children
  const code = (Array.isArray(raw) ? raw.join('') : typeof raw === 'string' ? raw : '').replace(
    /\n$/,
    ''
  )
  return { code, lang }
}

function InlineCode({ children }: ComponentProps<'code'>) {
  return <code className="md-code">{children}</code>
}

function Table({ children }: ComponentProps<'table'>) {
  return (
    <div className="md-table">
      <table>{children}</table>
    </div>
  )
}

function TaskCheckbox({ checked, type }: ComponentProps<'input'>) {
  if (type !== 'checkbox') return null
  return (
    <span
      className={cn('md-check', checked && 'md-check-on')}
      aria-checked={checked}
      role="checkbox"
    >
      {checked && <Check strokeWidth={3} />}
    </span>
  )
}

function Image({ src, alt }: ComponentProps<'img'>) {
  if (typeof src === 'string' && src.startsWith('data:image/'))
    return <img src={src} alt={alt ?? ''} className="md-img" />
  return (
    <Link href={typeof src === 'string' ? src : undefined}>
      {alt || (typeof src === 'string' ? src : 'image')}
    </Link>
  )
}

/** When mermaid fences render as diagrams (pi's `markdown.mermaid`): never, once the message is final, or as soon as the fence closes. */
export type MermaidMode = 'off' | 'final' | 'streaming'

const MermaidModeContext = createContext<MermaidMode>('streaming')

/** Sets the mermaid mode for every <Markdown> below it (the transcript passes the effective setting). */
export const MermaidModeProvider = MermaidModeContext.Provider

type MermaidModule = (typeof import('mermaid'))['default']
type MermaidConfig = Parameters<MermaidModule['initialize']>[0]

let mermaidModule: Promise<MermaidModule> | null = null
let mermaidTheme: string | null = null
let renderQueue: Promise<unknown> = Promise.resolve()
let renderCount = 0
const MAX_MERMAID_CACHE = 64
/** Rendered SVG (or null for a failed diagram) per theme + source: remounts and re-renders are free. */
const svgCache = new Map<string, string | null>()

function setCachedSvg(key: string, svg: string | null): void {
  if (svgCache.has(key)) svgCache.delete(key)
  else if (svgCache.size >= MAX_MERMAID_CACHE) {
    const oldest = svgCache.keys().next().value
    if (oldest !== undefined) svgCache.delete(oldest)
  }
  svgCache.set(key, svg)
}

function loadMermaid(): Promise<MermaidModule> {
  mermaidModule ??= import('mermaid').then((m) => m.default)
  return mermaidModule
}

const themeListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null

function subscribeDocumentTheme(onChange: () => void): () => void {
  themeListeners.add(onChange)
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const listener of themeListeners) listener()
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  }
  return () => {
    themeListeners.delete(onChange)
    if (themeListeners.size === 0 && themeObserver) {
      themeObserver.disconnect()
      themeObserver = null
    }
  }
}

function getDocumentTheme(): string {
  return document.documentElement.dataset.theme ?? 'dark'
}

/** Current `data-theme` of <html> (dark/light), as a subscribable value. */
function useDocumentTheme(): string {
  return useSyncExternalStore(subscribeDocumentTheme, getDocumentTheme)
}

/** A color token as opaque hex, composited over `--code-bg` (Mermaid derives shades itself and cannot read CSS variables). */
function tokenColor(probe: HTMLElement, ctx: CanvasRenderingContext2D, name: string): string {
  probe.style.color = 'var(--code-bg)'
  ctx.fillStyle = getComputedStyle(probe).color
  ctx.fillRect(0, 0, 1, 1)
  probe.style.color = `var(${name})`
  ctx.fillStyle = getComputedStyle(probe).color
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function mermaidConfig(theme: string): MermaidConfig {
  const probe = document.createElement('span')
  probe.className = 'md'
  document.body.append(probe)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const color = (name: string) => tokenColor(probe, ctx, name)
  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()
  const fg = color('--fg')
  const fg2 = color('--fg-2')
  const line = color('--fg-3')
  const border = color('--hairline-strong')
  const node = color('--surface-3')
  const raised = color('--surface-4')
  const panel = color('--code-bg')
  probe.remove()
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    look: 'classic',
    fontFamily,
    themeVariables: {
      darkMode: theme !== 'light',
      fontFamily,
      fontSize: '13px',
      background: panel,
      primaryColor: node,
      primaryTextColor: fg,
      primaryBorderColor: border,
      secondaryColor: raised,
      secondaryTextColor: fg,
      secondaryBorderColor: border,
      tertiaryColor: panel,
      tertiaryTextColor: fg2,
      tertiaryBorderColor: border,
      mainBkg: node,
      nodeBorder: border,
      nodeTextColor: fg,
      lineColor: line,
      textColor: fg2,
      titleColor: fg,
      clusterBkg: panel,
      clusterBorder: border,
      edgeLabelBackground: panel,
      noteBkgColor: raised,
      noteTextColor: fg2,
      noteBorderColor: border,
      actorBkg: node,
      actorBorder: border,
      actorTextColor: fg,
      actorLineColor: line,
      signalColor: fg2,
      signalTextColor: fg2,
      labelBoxBkgColor: node,
      labelBoxBorderColor: border,
      labelTextColor: fg,
      loopTextColor: fg2,
      activationBkgColor: raised,
      activationBorderColor: border,
      sequenceNumberColor: panel
    }
  }
}

/** Render one diagram (serialized: Mermaid keeps global render state); null when the source is invalid. */
function renderMermaid(code: string, theme: string): Promise<string | null> {
  const key = `${theme}\n${code}`
  if (svgCache.has(key)) return Promise.resolve(svgCache.get(key) ?? null)
  const job = renderQueue.then(async () => {
    const mermaid = await loadMermaid()
    if (mermaidTheme !== theme) {
      mermaid.initialize(mermaidConfig(theme))
      mermaidTheme = theme
    }
    const svg = await mermaid.render(`v-mermaid-${++renderCount}`, code).then(
      (result) => result.svg,
      () => null
    )
    setCachedSvg(key, svg)
    return svg
  })
  renderQueue = job.catch(() => undefined)
  return job
}

/** A mermaid fence as a diagram (lazy-loaded renderer themed from the design tokens); the source when invalid. */
const MermaidBlock = memo(function MermaidBlock({ code }: { code: string }) {
  const theme = useDocumentTheme()
  const key = `${theme}\n${code}`
  const [result, setResult] = useState<{ key: string; svg: string | null } | null>(() =>
    svgCache.has(key) ? { key, svg: svgCache.get(key) ?? null } : null
  )
  useEffect(() => {
    let alive = true
    void renderMermaid(code, theme).then((svg) => alive && setResult({ key, svg }))
    return () => {
      alive = false
    }
  }, [code, theme, key])
  const current = result?.key === key ? result : null
  if (current && current.svg === null)
    return <CodeBlock code={code} lang="mermaid" note="Diagram could not be drawn" />
  return (
    <div
      data-mermaid
      className="group/code relative my-4 overflow-hidden rounded-card bg-[var(--code-bg)] shadow-[inset_0_0_0_1px_var(--hairline)]"
    >
      <div className="flex h-8 items-center gap-2 border-b border-hairline-soft pr-1.5 pl-3.5">
        <span className="text-xs font-medium text-fg-3">Diagram</span>
        <div className="flex-1" />
        <CopyButton
          value={code}
          label="Copy diagram source"
          className="opacity-60 transition-opacity group-hover/code:opacity-100"
        />
      </div>
      {current?.svg ? (
        // Mermaid output with securityLevel 'strict' (labels escaped, scripts and click handlers stripped).
        <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: current.svg }} />
      ) : (
        <div className="flex h-28 items-center justify-center text-sm">
          <Shimmer>Drawing diagram…</Shimmer>
        </div>
      )}
    </div>
  )
})

const FENCE_CLOSED = /\n {0,3}(`{3,}|~{3,})\s*$/
/**
 * A block with a mermaid fence: the only kind whose rendering depends on its message still streaming. Loose on
 * purpose (fences inside quotes and nested lists sit after `>` or deeper indents): a false match costs one render.
 */
const MERMAID_FENCE = /(`{3,}|~{3,})\s*mermaid/

/** `live` = streaming tail block, `messageLive` = its message is still streaming, `closed` = the tail's fence is complete. */
interface MarkdownRenderState {
  live: boolean
  messageLive: boolean
  closed: boolean
  mermaid: MermaidMode
}

const MarkdownRenderContext = createContext<MarkdownRenderState>({
  live: false,
  messageLive: false,
  closed: false,
  mermaid: 'streaming'
})

function MarkdownPre({ children }: ComponentProps<'pre'>) {
  const { live, messageLive, closed, mermaid } = useContext(MarkdownRenderContext)
  const { code, lang } = codeOf(children)
  const diagram =
    lang === 'mermaid' &&
    (mermaid === 'streaming' ? !live || closed : mermaid === 'final' && !messageLive)
  return diagram ? (
    <MermaidBlock code={code} />
  ) : (
    <CodeBlock code={code} lang={lang} live={live} />
  )
}

const COMPONENTS: Components = {
  a: Link,
  code: InlineCode,
  pre: MarkdownPre,
  table: Table,
  input: TaskCheckbox,
  img: Image
}

const STANDALONE_FENCE_OPEN = /^(`{3,}|~{3,})([\w+#.-]*)[ \t]*$/

function parseStandaloneFence(
  source: string
): { code: string; lang: string | null; closed: boolean } | null {
  if (source.charCodeAt(0) !== 96 && source.charCodeAt(0) !== 126) return null
  const firstNl = source.indexOf('\n')
  const firstLine = (firstNl === -1 ? source : source.slice(0, firstNl)).replace(/\r$/, '')
  const match = STANDALONE_FENCE_OPEN.exec(firstLine)
  if (!match) return null
  const fence = match[1]!
  const fenceChar = fence[0]!
  const lang = match[2] || null
  if (firstNl === -1) return { code: '', lang, closed: false }
  const body = source.slice(firstNl + 1)
  const lastNl = body.lastIndexOf('\n')
  const lastLine = (lastNl === -1 ? body : body.slice(lastNl + 1)).replace(/\r$/, '')
  const prefix = lastNl === -1 ? '' : body.slice(0, lastNl)
  // If any earlier line could close the fence, let ReactMarkdown parse it.
  if (prefix.includes(fence)) return null
  const trimmedLast = lastLine.trim()
  const isClosed =
    trimmedLast.length >= fence.length &&
    trimmedLast[0] === fenceChar &&
     lastLine.startsWith(trimmedLast) &&
    /^(`+|~+)$/.test(trimmedLast)
  if (isClosed) {
    return { code: prefix.replace(/\n$/, ''), lang, closed: true }
  }
  return { code: body.replace(/\n$/, ''), lang, closed: false }
}

const MAX_RENDERED_BLOCKS = 500
const settledRenderCache = new Map<string, ReactNode>()

function putSettledRender(source: string, node: ReactNode): ReactNode {
  if (settledRenderCache.has(source)) {
    settledRenderCache.delete(source)
  } else if (settledRenderCache.size >= MAX_RENDERED_BLOCKS) {
    const oldest = settledRenderCache.keys().next().value
    if (oldest !== undefined) settledRenderCache.delete(oldest)
  }
  settledRenderCache.set(source, node)
  return node
}

function renderMarkdownAst(source: string): ReactNode {
  return ReactMarkdown({
    remarkPlugins: REMARK_PLUGINS,
    components: COMPONENTS,
    children: source
  })
}

const Block = memo(function Block({
  source,
  live,
  messageLive
}: {
  source: string
  live: boolean
  messageLive: boolean
}) {
  const mermaid = useContext(MermaidModeContext)
  const standalone = useMemo(() => parseStandaloneFence(source), [source])
  const closed = live && (standalone ? standalone.closed : FENCE_CLOSED.test(source))
  const renderState = useMemo(
    () => ({ live, messageLive, closed, mermaid }),
    [live, messageLive, closed, mermaid]
  )
  const lastRef = useRef<{ source: string; node: ReactNode } | null>(null)
  if (standalone) {
    const diagram =
      standalone.lang === 'mermaid' &&
      (mermaid === 'streaming' ? !live || closed : mermaid === 'final' && !messageLive)
    return diagram ? (
      <MermaidBlock code={standalone.code} />
    ) : (
      <CodeBlock code={standalone.code} lang={standalone.lang} live={live} />
    )
  }
  let content: ReactNode
  if (!live) {
    const cached = settledRenderCache.get(source)
    if (cached !== undefined) {
      settledRenderCache.delete(source)
      settledRenderCache.set(source, cached)
      content = cached
    } else if (lastRef.current?.source === source) {
      content = putSettledRender(source, lastRef.current.node)
    } else {
      content = putSettledRender(source, renderMarkdownAst(source))
    }
  } else if (lastRef.current?.source === source) {
    content = lastRef.current.node
  } else {
    content = renderMarkdownAst(source)
    lastRef.current = { source, node: content }
  }
  return (
    <MarkdownRenderContext.Provider value={renderState}>
      {content}
    </MarkdownRenderContext.Provider>
  )
})

const MAX_CACHED_SPLITS = 250
const settledBlockCache = new Map<string, string[]>()

function getSettledBlocks(text: string, splitter: MarkdownBlockSplitter): string[] {
  const cached = settledBlockCache.get(text)
  if (cached !== undefined) {
    settledBlockCache.delete(text)
    settledBlockCache.set(text, cached)
    return cached
  }
  const blocks = splitter.split(text)
  if (settledBlockCache.size >= MAX_CACHED_SPLITS) {
    const oldest = settledBlockCache.keys().next().value
    if (oldest !== undefined) settledBlockCache.delete(oldest)
  }
  settledBlockCache.set(text, blocks)
  return blocks
}

/**
 * While `live`, reveal streamed text at a steady per-frame pace instead of in network-sized chunks.
 * Catches up proportionally (never lags far behind) and snaps to the full text once streaming ends.
 */
function useSmoothText(text: string, live: boolean): string {
  const revealed = useRef(text.length)
  const target = useRef(text.length)
  target.current = text.length
  const frame = useRef<number | null>(null)
  const [length, setLength] = useState(() => text.length)
  useEffect(() => {
    if (!live) {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      revealed.current = text.length
      setLength(text.length)
      return
    }
    if (revealed.current === target.current || frame.current !== null) return
    const tick = () => {
      frame.current = null
      const minimumReveal = 2
      const catchUpFrames = 7
      const remaining = target.current - revealed.current
      revealed.current = Math.min(
        target.current,
        revealed.current + Math.max(minimumReveal, Math.ceil(remaining / catchUpFrames))
      )
      setLength(revealed.current)
      if (revealed.current < target.current) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [live, text.length])
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    },
    []
  )
  return live ? text.slice(0, length) : text
}

export interface MarkdownProps {
  text: string
  /** Streaming: smooth reveal, caret on the tail, code blocks highlight once complete. */
  live?: boolean
  /** `prose` = transcript body (15px), `compact` = tool cards / panels (13px). */
  size?: 'prose' | 'compact'
  className?: string
}

/** GitHub-flavored markdown, split into memoized blocks so streaming only re-renders the tail. */
export const Markdown = memo(function Markdown({
  text,
  live = false,
  size = 'prose',
  className
}: MarkdownProps) {
  const shown = useSmoothText(text, live)
  const [splitter] = useState(() => new MarkdownBlockSplitter())
  const blocks = useMemo(
    () => (live ? splitter.split(shown) : getSettledBlocks(shown, splitter)),
    [live, shown, splitter]
  )
  return (
    <div
      className={cn(
        'md selectable',
        size === 'compact' && 'md-compact',
        live && 'md-live',
        className
      )}
    >
      {blocks.map((source, i) => (
        <Block
          key={i}
          source={source}
          live={live && i === blocks.length - 1}
          messageLive={live && MERMAID_FENCE.test(source)}
        />
      ))}
    </div>
  )
})
