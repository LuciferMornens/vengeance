import { Fragment, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'

const WINDOWING_THRESHOLD = 40
const OVERSCAN_ROWS = 4
const SESSION_ROW_HEIGHT = 50

interface WindowedListProps<Item> {
  items: readonly Item[]
  itemKey: (item: Item) => string
  children: (item: Item) => ReactNode
  estimateSize?: number
  scrollSelector?: string
  focusSelector?: string
  wrapFocus?: boolean
  isItemFocusable?: (item: Item) => boolean
}

/** Lists share their surrounding scroll surface, including lists nested in workspace groups. */
export function WindowedList<Item>(props: WindowedListProps<Item>) {
  if (props.items.length <= WINDOWING_THRESHOLD) {
    return props.items.map((item) => (
      <Fragment key={props.itemKey(item)}>{props.children(item)}</Fragment>
    ))
  }
  return <VirtualRows {...props} />
}

function VirtualRows<Item>({
  items,
  itemKey,
  children,
  estimateSize = SESSION_ROW_HEIGHT,
  scrollSelector = '[data-session-list]',
  focusSelector = '[data-session-row]',
  wrapFocus = false,
  isItemFocusable
}: WindowedListProps<Item>) {
  const root = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ index: number; last: boolean } | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const measuredMargin = useRef(0)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const focusedIndex =
    focusedKey === null ? -1 : items.findIndex((item) => itemKey(item) === focusedKey)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => root.current?.closest<HTMLElement>(scrollSelector) ?? null,
    estimateSize: () => estimateSize,
    getItemKey: (index) => itemKey(items[index]!),
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) {
        indexes.push(focusedIndex)
        indexes.sort((first, second) => first - second)
      }
      return indexes
    }
  })

  const measureScrollMargin = useCallback(() => {
    const element = root.current
    const scroll = element?.closest<HTMLElement>(scrollSelector)
    if (!element || !scroll) return
    const margin =
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    if (measuredMargin.current === margin) return
    measuredMargin.current = margin
    setScrollMargin(margin)
  }, [scrollSelector])

  // A virtualized ancestor can move by transform without triggering a resize observation.
  useLayoutEffect(measureScrollMargin)

  useLayoutEffect(() => {
    const element = root.current
    const scroll = element?.closest<HTMLElement>(scrollSelector)
    if (!element || !scroll) return
    const observer = new ResizeObserver(measureScrollMargin)
    // An expanding sibling changes this list's offset without changing its own height.
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent)
      for (const sibling of parent.children) observer.observe(sibling)
      if (parent === scroll) break
    }
    return () => observer.disconnect()
  }, [measureScrollMargin, scrollSelector])

  useLayoutEffect(() => {
    if (pendingFocus.current === null) return
    const elements = root.current?.querySelectorAll<HTMLElement>(
      `:scope > [data-windowed-index="${pendingFocus.current.index}"] ${focusSelector}`
    )
    const element = pendingFocus.current.last ? elements?.[elements.length - 1] : elements?.[0]
    if (element) {
      element.focus({ preventScroll: true })
      pendingFocus.current = null
    }
  })

  return (
    <div
      ref={root}
      data-windowed-list
      style={{ position: 'relative', height: virtualizer.getTotalSize(), flexShrink: 0 }}
      onFocusCapture={(event) => {
        let row = event.target.closest<HTMLElement>('[data-windowed-index]')
        while (row && row.parentElement !== root.current) {
          row = row.parentElement?.closest<HTMLElement>('[data-windowed-index]') ?? null
        }
        if (row?.parentElement !== root.current) return
        const item = items[Number(row.dataset.windowedIndex)]
        if (item) setFocusedKey(itemKey(item))
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const target = event.target as HTMLElement
        if (!target.matches(focusSelector)) return
        let row = target.closest<HTMLElement>('[data-windowed-index]')
        while (row && row.parentElement !== root.current) {
          row = row.parentElement?.closest<HTMLElement>('[data-windowed-index]') ?? null
        }
        if (!row) return
        const choices = [...row.querySelectorAll<HTMLElement>(focusSelector)]
        const position = choices.indexOf(target)
        const step = event.key === 'ArrowDown' ? 1 : -1
        if (choices[position + step]) return
        const index = Number(row.dataset.windowedIndex)
        let nextIndex = index
        do {
          const adjacent = nextIndex + step
          if (!wrapFocus && (adjacent < 0 || adjacent >= items.length)) return
          nextIndex = (adjacent + items.length) % items.length
          if (nextIndex === index) return
        } while (isItemFocusable && !isItemFocusable(items[nextIndex]!))
        event.preventDefault()
        event.stopPropagation()
        pendingFocus.current = { index: nextIndex, last: step < 0 }
        setFocusedKey(itemKey(items[nextIndex]!))
        virtualizer.scrollToIndex(nextIndex, { align: 'auto' })
      }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          data-windowed-index={row.index}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${row.start - scrollMargin}px)`
          }}
        >
          {children(items[row.index]!)}
        </div>
      ))}
    </div>
  )
}
