import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { openExternal } from '../../ui/Markdown'
import { isRecord } from './tool-utils'

/**
 * Structured view of JSON tool data (r4 item 6): a key/value grid where nested objects and arrays become tidy
 * indented trees, URLs are links and identifiers are mono chips. Raw JSON stays one click away (a row
 * detail's Raw view).
 */

const MAX_DEPTH = 4
const MAX_NODES = 400
const MAX_ROWS = 40
const MAX_ITEMS = 25

/** Parse a tool result that is entirely a JSON object or array (null otherwise). */
export function parseJsonData(text: string): Record<string, unknown> | unknown[] | null {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return null
  try {
    const value: unknown = JSON.parse(t)
    return isRecord(value) || Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** Output that ends with a JSON object/array after some text (script logs): `{ prose, data }`, else null. */
export function splitTrailingJson(text: string): { prose: string; data: Record<string, unknown> | unknown[] } | null {
  const lines = text.trimEnd().split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (!/^\s*[[{]/.test(lines[i]!)) continue
    const data = parseJsonData(lines.slice(i).join('\n'))
    if (data) return { prose: lines.slice(0, i).join('\n').trimEnd(), data }
  }
  return null
}

function countNodes(value: unknown, budget = MAX_NODES): number {
  let n = 0
  const walk = (v: unknown) => {
    if (n > budget) return
    n++
    if (Array.isArray(v)) v.forEach(walk)
    else if (isRecord(v)) Object.values(v).forEach(walk)
  }
  walk(value)
  return n
}

/** Whether `value` nests at most `levels` deep. Stops descending past `levels`: tool JSON can nest thousands deep. */
function withinDepth(value: unknown, levels: number): boolean {
  const children = Array.isArray(value) ? value.slice(0, MAX_ITEMS) : isRecord(value) ? Object.values(value) : null
  if (!children) return true
  return levels > 0 && children.every((child) => withinDepth(child, levels - 1))
}

/** Data the tree renders well: not empty, not too deep, not huge. Anything else is shown as highlighted JSON. */
export function fitsJsonTree(value: unknown): boolean {
  const size = Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : 0
  return size > 0 && withinDepth(value, MAX_DEPTH) && countNodes(value) <= MAX_NODES
}

const ACRONYMS = new Set(['id', 'ids', 'url', 'urls', 'uri', 'api', 'ui', 'mcp', 'html', 'json', 'sha', 'utc', 'ip', 'os'])

/** `nextCursor` / `created_at` / `url` → "Next cursor" / "Created at" / "URL"; the raw key stays in the tooltip. */
function keyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
  if (words.length === 0) return key
  return words
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (ACRONYMS.has(lower)) return lower === 'ids' ? 'IDs' : lower === 'urls' ? 'URLs' : lower.toUpperCase()
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

const URL_RE = /^https?:\/\/\S+$/i
const ID_KEY = /^(id|uuid|guid|key|sha|hash|ref|slug|identifier|number)$|(_id|Id|ID|_key|Key|_sha|Sha)$/
const ID_VALUE = /^([A-Z][A-Z0-9]{1,9}-\d+|[0-9a-f]{7,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|#\d+)$/
/** Keys whose values are code-like (paths, commands, patterns) and read best in mono. */
const CODE_KEY = /^(command|cmd|code|script|pattern|regex|glob|path|paths|file|files|filepath|filename|cwd|dir|directory|branch|ref|selector|query)$/i

function isIdentifier(key: string | null, value: string): boolean {
  return value.length <= 64 && !/\s/.test(value) && ((key !== null && ID_KEY.test(key)) || ID_VALUE.test(value))
}

function isCodeLike(key: string | null, value: string): boolean {
  return (key !== null && CODE_KEY.test(key)) || (!/\s/.test(value) && /[\\/]/.test(value) && value.length <= 200)
}

function IdChip({ children }: { children: string }) {
  return <span className="inline-flex h-5 max-w-full items-center truncate rounded-xs bg-hover px-1.5 font-mono text-[11.5px] text-fg shadow-[inset_0_0_0_1px_var(--hairline-soft)]">{children}</span>
}

function UrlLink({ href }: { href: string }) {
  let shown = href
  try {
    const url = new URL(href)
    shown = `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}${url.search}`
  } catch {
    // Not parseable: show it as written.
  }
  return (
    <button
      type="button"
      title={href}
      onClick={() => openExternal(href)}
      className="max-w-full truncate text-left text-accent-text underline decoration-[color-mix(in_oklab,var(--accent-2)_45%,transparent)] underline-offset-[3px] transition-[text-decoration-color] duration-[var(--dur-fast)] hover:decoration-[var(--accent-2)]"
    >
      {shown}
    </button>
  )
}

function Scalar({ name, value }: { name: string | null; value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="text-fg-3">—</span>
  if (typeof value === 'boolean') return <span className="text-fg">{value ? 'true' : 'false'}</span>
  if (typeof value === 'number') return <span className="text-fg tabular">{value.toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>
  const text = String(value)
  if (text === '') return <span className="text-fg-3">Empty</span>
  if (URL_RE.test(text)) return <UrlLink href={text} />
  if (isIdentifier(name, text)) return <IdChip>{text}</IdChip>
  if (text.includes('\n') || text.length > 160) {
    return <div className={cn('line-clamp-8 break-words whitespace-pre-wrap text-fg-2', isCodeLike(name, text) ? 'font-mono text-[12px] leading-relaxed' : 'leading-relaxed')}>{text}</div>
  }
  if (isCodeLike(name, text)) return <span className="font-mono text-[12px] break-all text-fg">{text}</span>
  return <span className="break-words text-fg">{text}</span>
}

const isScalar = (v: unknown) => v === null || typeof v !== 'object'

/** Title of a record in a list: its name/title-like field, if any. */
function recordTitle(record: Record<string, unknown>): { key: string; text: string } | null {
  for (const key of ['title', 'name', 'label', 'summary', 'displayName']) {
    const v = record[key]
    if (typeof v === 'string' && v.trim() && v.length <= 120 && !v.includes('\n')) return { key, text: v }
  }
  return null
}

function More({ count, unit }: { count: number; unit: string }) {
  return <div className="text-xs text-fg-3">{`${count} more ${unit}`}</div>
}

function Value({ name, value, depth }: { name: string | null; value: unknown; depth: number }): ReactNode {
  if (isScalar(value)) return <Scalar name={name} value={value} />
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-fg-3">None</span>
    if (value.every(isScalar)) {
      const shown = value.slice(0, MAX_ITEMS)
      return (
        <span className="flex flex-wrap gap-1">
          {shown.map((v, i) =>
            typeof v === 'string' && URL_RE.test(v) ? (
              <UrlLink key={i} href={v} />
            ) : (
              <span key={i} className="inline-flex h-5 items-center rounded-xs bg-hover px-1.5 text-xs text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline-soft)]">
                {v === null ? '—' : String(v)}
              </span>
            )
          )}
          {value.length > shown.length && <span className="inline-flex h-5 items-center text-xs text-fg-3">+{value.length - shown.length}</span>}
        </span>
      )
    }
    return <RecordList items={value} depth={depth} />
  }
  return (
    <div className="border-l border-hairline pl-3">
      <Grid record={value as Record<string, unknown>} depth={depth + 1} />
    </div>
  )
}

/** Array of objects: one compact block per item, titled by its name/title field (or its position). */
function RecordList({ items, depth }: { items: unknown[]; depth: number }) {
  const shown = items.slice(0, MAX_ITEMS)
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((item, i) => {
        if (!isRecord(item)) {
          return (
            <div key={i} className="border-l border-hairline pl-3">
              <Value name={null} value={item} depth={depth + 1} />
            </div>
          )
        }
        const title = recordTitle(item)
        const rest = title ? Object.fromEntries(Object.entries(item).filter(([k]) => k !== title.key)) : item
        return (
          <div key={i} className="rounded-md bg-surface-1 px-3 py-2 shadow-[inset_0_0_0_1px_var(--hairline-soft)]">
            <div className={cn('flex min-w-0 items-baseline gap-2', Object.keys(rest).length > 0 && 'mb-1.5')}>
              <span className="shrink-0 text-xs text-fg-3 tabular">{i + 1}</span>
              {title && <span className="min-w-0 truncate text-[13px] font-medium text-fg">{title.text}</span>}
            </div>
            {Object.keys(rest).length > 0 && <Grid record={rest} depth={depth + 1} />}
          </div>
        )
      })}
      {items.length > shown.length && <More count={items.length - shown.length} unit="items" />}
    </div>
  )
}

function Grid({ record, depth }: { record: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(record)
  const shown = entries.slice(0, MAX_ROWS)
  return (
    <div className="grid grid-cols-[minmax(72px,max-content)_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
      {shown.map(([key, value]) => (
        <div key={key} className="contents">
          <div className="pt-px text-xs text-fg-3" title={key}>
            {keyLabel(key)}
          </div>
          <div className="selectable min-w-0 text-[13px]">
            <Value name={key} value={value} depth={depth} />
          </div>
        </div>
      ))}
      {entries.length > shown.length && (
        <div className="col-span-2">
          <More count={entries.length - shown.length} unit="fields" />
        </div>
      )}
    </div>
  )
}

/** Key/value tree of a JSON object or array (check `fitsJsonTree` first). */
export function JsonTree({ value, className }: { value: Record<string, unknown> | unknown[]; className?: string }) {
  return (
    <div className={cn('px-3.5 py-3', className)}>
      {Array.isArray(value) ? <Value name={null} value={value} depth={0} /> : <Grid record={value} depth={0} />}
    </div>
  )
}
