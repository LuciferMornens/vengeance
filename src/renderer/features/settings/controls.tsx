import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import type { ChoiceOption } from '@shared/api/settings-schema'
import { cn } from '../../lib/cn'
import { invoke } from './ipc'
import { IconButton, Input, SegmentedControl, Select } from '../../ui'

/** Form controls for settings: committed on blur/Enter, Escape reverts. */

/** Neutral keyboard-focus ring for fields (never the accent hue, which reads as an error). */
export const FOCUS_RING =
  'focus:shadow-[0_0_0_1px_color-mix(in_oklab,var(--fg)_24%,transparent),0_0_0_4px_color-mix(in_oklab,var(--fg)_7%,transparent)]'
export const FOCUS_WITHIN_RING =
  'focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--fg)_24%,transparent),0_0_0_4px_color-mix(in_oklab,var(--fg)_7%,transparent)]'

const UNIT_LABEL = {
  ms: 'ms',
  tokens: 'tokens',
  cells: 'cells',
  lines: 'lines',
  retries: 'tries'
} as const

export function humanizeMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (ms < 1000) return null
  const s = ms / 1000
  if (s < 60) return `${+s.toFixed(1)} s`
  const m = s / 60
  if (m < 60) return `${+m.toFixed(1)} min`
  return `${+(m / 60).toFixed(1)} h`
}

export function humanizeTokens(tokens: number): string | null {
  if (!Number.isFinite(tokens) || tokens < 1000) return null
  return tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(2)}M`
    : `${+(tokens / 1000).toFixed(1)}K`
}

export interface NumberFieldProps {
  value: number | undefined
  placeholder?: number | string
  onCommit: (value: number | undefined) => void
  min?: number
  max?: number
  integer?: boolean
  unit?: keyof typeof UNIT_LABEL
  disabled?: boolean
  /** Show the humanized value (≈ 5 min, ≈ 30K) beside the field. */
  showHint?: boolean
  className?: string
  'aria-label'?: string
}

export function NumberField({
  value,
  placeholder,
  onCommit,
  min,
  max,
  integer,
  unit,
  disabled,
  showHint = true,
  className,
  ...rest
}: NumberFieldProps) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    setDraft(value === undefined ? '' : String(value))
    setInvalid(false)
  }, [value])

  const commit = () => {
    const text = draft.trim().replace(/[_,\s]/g, '')
    if (text === '') {
      setInvalid(false)
      if (value !== undefined) onCommit(undefined)
      return
    }
    const parsed = Number(text)
    const bad =
      !Number.isFinite(parsed) ||
      (integer && !Number.isInteger(parsed)) ||
      (min !== undefined && parsed < min) ||
      (max !== undefined && parsed > max)
    setInvalid(bad)
    if (!bad && parsed !== value) onCommit(parsed)
  }

  const shown = draft.trim() === '' ? Number(placeholder) : Number(draft)
  const hint = !showHint
    ? null
    : unit === 'ms'
      ? humanizeMs(shown)
      : unit === 'tokens'
        ? humanizeTokens(shown)
        : null
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {hint && <span className="tabular text-xs text-fg-3">≈ {hint}</span>}
      <div className="relative">
        <input
          aria-label={rest['aria-label']}
          inputMode="numeric"
          disabled={disabled}
          value={draft}
          placeholder={placeholder === undefined ? '' : String(placeholder)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setDraft(value === undefined ? '' : String(value))
              setInvalid(false)
            }
          }}
          className={cn(
            'tabular h-8 w-[136px] rounded-md bg-surface-1 pr-14 pl-2.5 text-left text-ui text-fg placeholder:text-fg-3',
            'shadow-[inset_0_0_0_1px_var(--hairline)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--hairline-strong)]',
            FOCUS_RING,
            'disabled:opacity-45',
            !unit && 'pr-2.5',
            invalid &&
              'shadow-[0_0_0_1px_var(--danger)] focus:shadow-[0_0_0_1px_var(--danger),0_0_0_4px_var(--danger-soft)]'
          )}
        />
        {unit && (
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-fg-3">
            {UNIT_LABEL[unit]}
          </span>
        )}
      </div>
    </div>
  )
}

export interface TextFieldProps {
  value: string | undefined
  placeholder?: string
  onCommit: (value: string | undefined) => void
  mono?: boolean
  browse?: 'file' | 'folder'
  disabled?: boolean
  className?: string
  /** Keep empty string instead of removing the key. */
  keepEmpty?: boolean
}

export function TextField({
  value,
  placeholder,
  onCommit,
  mono,
  browse,
  disabled,
  className,
  keepEmpty
}: TextFieldProps) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => setDraft(value ?? ''), [value])
  const commit = (next = draft) => {
    const normalized = next === '' && !keepEmpty ? undefined : next
    if (normalized !== value) onCommit(normalized)
  }
  const pick = async () => {
    const picked =
      browse === 'folder'
        ? await invoke('sys:pick-folder', { defaultPath: value })
        : ((await invoke('sys:pick-files', { defaultPath: value, multiple: false }))[0] ?? null)
    if (picked) {
      setDraft(picked)
      commit(picked)
    }
  }
  return (
    <div className={cn('flex w-full items-center gap-1.5', className)}>
      <Input
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            setDraft(value ?? '')
          }
        }}
        className={cn('flex-1 bg-surface-1', FOCUS_RING, mono && 'font-mono text-sm')}
      />
      {browse && (
        <IconButton
          label={browse === 'folder' ? 'Choose folder…' : 'Choose file…'}
          variant="secondary"
          size="md"
          disabled={disabled}
          onClick={() => void pick()}
        >
          <FolderOpen />
        </IconButton>
      )}
    </div>
  )
}

const encode = (value: unknown) => JSON.stringify(value)

export interface ChoiceFieldProps {
  value: unknown
  options: ChoiceOption[]
  onChange: (value: ChoiceOption['value']) => void
  segmented?: boolean
  disabled?: boolean
  className?: string
}

export function ChoiceField({
  value,
  options,
  onChange,
  segmented,
  disabled,
  className
}: ChoiceFieldProps) {
  const all =
    options.some((o) => o.value === value) || value === undefined
      ? options
      : [...options, { value: value as string, label: String(value) }]
  const byKey = new Map(all.map((o) => [encode(o.value), o.value]))
  if (segmented) {
    return (
      <SegmentedControl
        className={cn(disabled && 'pointer-events-none opacity-45', className)}
        value={encode(value)}
        onValueChange={(key) => onChange(byKey.get(key)!)}
        segments={all.map((o) => ({ value: encode(o.value), label: o.label }))}
      />
    )
  }
  return (
    <Select
      className={cn('min-w-[180px]', className)}
      disabled={disabled}
      value={value === undefined ? undefined : encode(value)}
      onValueChange={(key) => onChange(byKey.get(key)!)}
      options={all.map((o) => ({
        value: encode(o.value),
        label: o.label,
        description: o.description
      }))}
    />
  )
}

export interface ListEditorProps {
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  /** Rendered before each chip (e.g. a status dot). */
  decorate?: (item: string) => ReactNode
  suggestions?: string[]
  /** Skip items already in the list. Off for ordered lists where repeats matter (command arguments). */
  unique?: boolean
}

/** Tag input for string lists (paths, patterns, command arguments). */
export function ListEditor({
  value,
  onChange,
  placeholder = 'Add…',
  mono,
  disabled,
  decorate,
  suggestions,
  unique = true
}: ListEditorProps) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useRef(`list-${Math.random().toString(36).slice(2)}`).current
  const add = (raw: string) => {
    const items = raw
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (items.length === 0) return
    onChange([...value, ...(unique ? items.filter((i) => !value.includes(i)) : items)])
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setDraft('')
    }
  }
  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md bg-surface-1 p-1.5 shadow-[inset_0_0_0_1px_var(--hairline)]',
        'transition-shadow',
        FOCUS_WITHIN_RING,
        disabled && 'pointer-events-none opacity-45'
      )}
    >
      {value.map((item, index) => (
        <span
          key={`${item}-${index}`}
          className={cn(
            'inline-flex h-6 max-w-full items-center gap-1.5 rounded-sm bg-surface-3 pr-1 pl-2 text-sm text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]',
            mono && 'font-mono text-xs'
          )}
        >
          {decorate?.(item)}
          <span className="truncate">{item}</span>
          <button
            type="button"
            aria-label={`Remove ${item}`}
            onClick={(e) => {
              e.stopPropagation()
              onChange(value.filter((_, i) => i !== index))
            }}
            className="flex size-4 items-center justify-center rounded-xs text-fg-4 hover:bg-active hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        list={suggestions ? listId : undefined}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        placeholder={value.length === 0 ? placeholder : ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => add(draft)}
        className={cn(
          'h-6 min-w-[140px] flex-1 bg-transparent px-1 text-sm text-fg placeholder:text-fg-3',
          mono && 'font-mono text-xs'
        )}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {draft.trim() && (
        <button
          type="button"
          aria-label="Add"
          onClick={() => add(draft)}
          className="flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
        >
          <Plus className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export function AutoNumberField({
  value,
  min,
  max,
  onChange,
  disabled
}: {
  value: unknown
  min: number
  max: number
  onChange: (value: number | 'auto' | undefined) => void
  disabled?: boolean
}) {
  const isAuto = value === undefined || value === 'auto'
  return (
    <div className="flex items-center gap-2">
      {!isAuto && (
        <NumberField
          value={typeof value === 'number' ? value : undefined}
          min={min}
          max={max}
          integer
          onCommit={(v) => onChange(v ?? 'auto')}
          disabled={disabled}
          className="[&_input]:w-[88px]"
        />
      )}
      <SegmentedControl
        className={cn(disabled && 'pointer-events-none opacity-45')}
        value={isAuto ? 'auto' : 'custom'}
        onValueChange={(mode) => onChange(mode === 'auto' ? 'auto' : 3)}
        segments={[
          { value: 'auto', label: 'Auto' },
          { value: 'custom', label: 'Custom' }
        ]}
      />
    </div>
  )
}

export interface KeyValueEditorProps {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
}

/**
 * Ordered key/value rows (environment variables, HTTP headers). Masked secrets (`••••abcd`) stay masked
 * until the value is retyped.
 */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'NAME',
  valuePlaceholder = 'value or ${VAR}',
  addLabel = 'Add'
}: KeyValueEditorProps) {
  // Local rows keep empty / duplicate keys while typing; the record is emitted without them.
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value))
  const emitted = useRef(JSON.stringify(value))
  useEffect(() => {
    const next = JSON.stringify(value)
    if (next !== emitted.current) {
      emitted.current = next
      setRows(Object.entries(value))
    }
  }, [value])
  const update = (next: Array<[string, string]>) => {
    setRows(next)
    const record = Object.fromEntries(
      next.filter(([key]) => key.trim()).map(([key, v]) => [key.trim(), v])
    )
    emitted.current = JSON.stringify(record)
    onChange(record)
  }
  const field = cn(
    'h-8 min-w-0 rounded-md bg-surface-1 px-2.5 font-mono text-xs text-fg placeholder:text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)] transition-shadow',
    FOCUS_RING
  )
  return (
    <div className="space-y-1.5">
      {rows.map(([key, v], index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            aria-label="Name"
            value={key}
            spellCheck={false}
            placeholder={keyPlaceholder}
            onChange={(e) =>
              update(rows.map((row, i) => (i === index ? [e.target.value, row[1]] : row)))
            }
            className={cn(field, 'w-[38%]')}
          />
          <input
            aria-label={`Value of ${key || 'entry'}`}
            value={v}
            spellCheck={false}
            placeholder={valuePlaceholder}
            onFocus={(e) => v.startsWith('•') && e.target.select()}
            onChange={(e) =>
              update(rows.map((row, i) => (i === index ? [row[0], e.target.value] : row)))
            }
            className={cn(field, 'flex-1')}
          />
          <IconButton
            label="Remove"
            size="sm"
            onClick={() => update(rows.filter((_, i) => i !== index))}
          >
            <X />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows([...rows, ['', '']])}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg [&_svg]:size-3.5"
      >
        <Plus />
        {addLabel}
      </button>
    </div>
  )
}
