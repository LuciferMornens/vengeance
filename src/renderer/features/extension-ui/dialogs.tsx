import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { CircleHelp, FilePenLine, ListChecks, Search, TextCursorInput } from 'lucide-react'
import type { ExtensionUIDialogRequest } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { Button, fieldClass, Input, Kbd, listRowClass } from '../../ui'
import { fuzzyMatch } from '../composer/fuzzy'
import { Highlight } from '../composer/SuggestionMenu'
import { DialogFrame, RichText, type DialogFrameProps } from './DialogFrame'

type Request<M extends ExtensionUIDialogRequest['method']> = Extract<ExtensionUIDialogRequest, { method: M }>

export interface DialogAnswer {
  value(value: string): void
  confirm(confirmed: boolean): void
  cancel(): void
}

export type FrameExtras = Pick<DialogFrameProps, 'open' | 'position' | 'deadline'>

// ─── select ──────────────────────────────────────────────────────────────────────────────────

const SEARCH_THRESHOLD = 6

export function SelectDialog({ request, answer, frame }: { request: Request<'select'>; answer: DialogAnswer; frame: FrameExtras }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchable = request.options.length > SEARCH_THRESHOLD

  const visible = useMemo(() => {
    const all = request.options.map((option, index) => ({ option, index, indices: undefined as number[] | undefined, score: 0 }))
    if (!query) return all
    return all
      .flatMap((item) => {
        const hit = fuzzyMatch(item.option, query)
        return hit ? [{ ...item, indices: hit.indices, score: hit.score }] : []
      })
      .sort((a, b) => b.score - a.score)
  }, [request.options, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (visible.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + delta + visible.length) % visible.length)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : Math.max(0, visible.length - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = visible[active]
      if (item) answer.value(item.option)
    } else if (!searchable && !query && /^[1-9]$/.test(event.key)) {
      const item = visible[Number(event.key) - 1]
      if (item) {
        event.preventDefault()
        answer.value(item.option)
      }
    }
  }

  return (
    <DialogFrame
      {...frame}
      size="picker"
      title={request.title}
      icon={<ListChecks />}
      onDismiss={answer.cancel}
      onKeyDown={onKeyDown}
      bodyClassName="px-3 pb-1"
      hint={searchable ? { combo: 'enter', label: 'choose' } : { combo: '1', label: 'quick pick' }}
      footer={
        <Button variant="ghost" size="sm" onClick={answer.cancel}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col">
        {searchable && (
          <div className="px-2 pt-0.5 pb-2">
            <Input
              data-autofocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${request.options.length} options…`}
              leading={<Search />}
              trailing={query ? <span className="tabular text-2xs text-fg-3">{visible.length}</span> : undefined}
            />
          </div>
        )}
        <div
          ref={listRef}
          tabIndex={searchable ? -1 : 0}
          data-autofocus={searchable ? undefined : true}
          className="max-h-[340px] overflow-y-auto outline-none"
          role="listbox"
          aria-label={request.title}
        >
          {visible.length === 0 && <div className="py-8 text-center text-sm text-fg-3">No option matches “{query}”</div>}
          {visible.map((item, i) => (
            <div
              key={item.index}
              role="option"
              aria-selected={i === active}
              data-index={i}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => answer.value(item.option)}
              className={cn(
                listRowClass({ density: 'list' }),
                'cursor-default',
                i === active && 'before:absolute before:top-1.5 before:bottom-1.5 before:left-1 before:w-[2px] before:rounded-[1px] before:bg-accent'
              )}
            >
              <Highlight text={item.option} indices={item.indices} className="min-w-0 flex-1 leading-snug break-words" />
              {!searchable && i < 9 && <Kbd combo={String(i + 1)} size="xs" className={cn('opacity-0 transition-opacity duration-[var(--dur-instant)]', i === active && 'opacity-100')} />}
            </div>
          ))}
        </div>
      </div>
    </DialogFrame>
  )
}

// ─── confirm ─────────────────────────────────────────────────────────────────────────────────

export function ConfirmDialog({ request, answer, frame }: { request: Request<'confirm'>; answer: DialogAnswer; frame: FrameExtras }) {
  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase()
    // Enter on a focused button activates that button natively.
    if (key === 'y' || (key === 'enter' && !(event.target instanceof HTMLButtonElement))) {
      event.preventDefault()
      answer.confirm(true)
    } else if (key === 'n') {
      event.preventDefault()
      answer.confirm(false)
    }
  }
  return (
    <DialogFrame
      {...frame}
      size="confirm"
      title={request.title}
      icon={<CircleHelp />}
      description={request.message ? <RichText text={request.message} /> : undefined}
      onDismiss={answer.cancel}
      onKeyDown={onKeyDown}
      hint={{ combo: 'y', label: 'yes' }}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => answer.confirm(false)}>
            No
          </Button>
          <Button variant="primary" size="sm" onClick={() => answer.confirm(true)}>
            Yes
          </Button>
        </>
      }
    />
  )
}

// ─── input ───────────────────────────────────────────────────────────────────────────────────

export function InputDialog({ request, answer, frame }: { request: Request<'input'>; answer: DialogAnswer; frame: FrameExtras }) {
  const [value, setValue] = useState('')
  return (
    <DialogFrame
      {...frame}
      size="form"
      title={request.title}
      icon={<TextCursorInput />}
      onDismiss={answer.cancel}
      hint={{ combo: 'enter', label: 'submit' }}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={answer.cancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => answer.value(value)}>
            Submit
          </Button>
        </>
      }
    >
      <div className="pt-1 pb-2">
        <Input
          data-autofocus
          value={value}
          placeholder={request.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              answer.value(value)
            }
          }}
          className="h-9"
        />
      </div>
    </DialogFrame>
  )
}

// ─── editor ──────────────────────────────────────────────────────────────────────────────────

export function EditorDialog({ request, answer, frame }: { request: Request<'editor'>; answer: DialogAnswer; frame: FrameExtras }) {
  const initial = request.prefill ?? ''
  const [value, setValue] = useState(initial)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const gutterRef = useRef<HTMLDivElement>(null)
  const lines = value.split('\n').length
  const dirty = value !== initial

  const updateCursor = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart)
    const line = before.split('\n').length
    setCursor({ line, col: before.length - before.lastIndexOf('\n') })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      answer.value(value)
    } else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      const start = el.selectionStart
      const next = `${value.slice(0, start)}  ${value.slice(el.selectionEnd)}`
      setValue(next)
      requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
    }
  }

  return (
    <DialogFrame
      {...frame}
      size="editor"
      title={request.title}
      icon={<FilePenLine />}
      onDismiss={() => {
        if (dirty && !confirmDiscard) {
          setConfirmDiscard(true)
          return false
        }
        answer.cancel()
      }}
      hint={confirmDiscard ? { combo: 'escape', label: 'again to discard changes' } : { combo: 'mod+enter', label: 'save' }}
      footer={
        <>
          <span className="tabular mr-2 text-2xs text-fg-3">
            Ln {cursor.line}, Col {cursor.col} · {lines} {lines === 1 ? 'line' : 'lines'}
          </span>
          <Button variant="ghost" size="sm" onClick={answer.cancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => answer.value(value)}>
            Save
          </Button>
        </>
      }
    >
      <div className="pt-1 pb-2">
        <div className={cn(fieldClass, 'flex h-[min(50vh,440px)] overflow-hidden bg-surface-1 focus-within:shadow-focus hover:shadow-[var(--highlight),0_0_0_1px_var(--hairline)]')}>
          <div ref={gutterRef} className="w-11 shrink-0 overflow-hidden border-r border-hairline-soft py-3 text-right font-mono text-xs leading-[21px] text-fg-4 select-none" aria-hidden>
            {Array.from({ length: lines }, (_, i) => (
              <div key={i} className={cn('pr-2.5', i + 1 === cursor.line && 'text-fg-2')}>
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            data-autofocus
            value={value}
            spellCheck={false}
            onChange={(e) => {
              setValue(e.target.value)
              setConfirmDiscard(false)
              updateCursor(e.target)
            }}
            onSelect={(e) => updateCursor(e.currentTarget)}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
            }}
            className="min-w-0 flex-1 resize-none bg-transparent px-3.5 py-3 font-mono text-[13px] leading-[21px] whitespace-pre text-fg outline-none"
          />
        </div>
      </div>
    </DialogFrame>
  )
}
