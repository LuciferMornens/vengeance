import { useCallback, useState, type RefObject } from 'react'
import { elementScroll, useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'

/** The transcript column's pt-8 padding is above the virtual list. */
export const TRANSCRIPT_TOP_PADDING = 32
const ESTIMATED_SEGMENT_HEIGHT = 180

export interface ScrollLayoutSnapshot {
  sizes: Map<string, number>
  scrollTop: number
  anchor: { key: string; offset: number } | null
}

export function captureScrollLayout(element: HTMLElement | null): ScrollLayoutSnapshot | null {
  if (!element) return null
  const viewportTop = element.getBoundingClientRect().top
  const snapshot: ScrollLayoutSnapshot = {
    sizes: new Map(),
    scrollTop: element.scrollTop,
    anchor: null
  }
  for (const row of element.querySelectorAll<HTMLElement>('[data-segment-key]')) {
    const key = row.dataset.segmentKey!
    const rectangle = row.getBoundingClientRect()
    snapshot.sizes.set(key, rectangle.height)
    if (!snapshot.anchor && rectangle.bottom > viewportTop) {
      snapshot.anchor = { key, offset: viewportTop - rectangle.top }
    }
  }
  return snapshot
}

function initialVirtualLayout(
  segments: readonly { key: string }[],
  snapshot: ScrollLayoutSnapshot | null
): { measurements: VirtualItem[]; offset: number | null } {
  if (!snapshot) return { measurements: [], offset: null }
  const measurements: VirtualItem[] = []
  let start = TRANSCRIPT_TOP_PADDING
  let offset: number | null = null
  let leadingSize: number | null = null
  for (const [index, segment] of segments.entries()) {
    const size = snapshot.sizes.get(segment.key) ?? ESTIMATED_SEGMENT_HEIGHT
    if (snapshot.sizes.has(segment.key)) leadingSize ??= start - TRANSCRIPT_TOP_PADDING
    if (segment.key === snapshot.anchor?.key) offset = start + snapshot.anchor.offset
    measurements.push({ index, key: segment.key, start, size, end: start + size, lane: 0 })
    start += size
  }
  return { measurements, offset: offset ?? snapshot.scrollTop + (leadingSize ?? 0) }
}

interface TranscriptVirtualizerOptions {
  segments: readonly { key: string }[]
  scrollElement: HTMLDivElement | null
  followsLatest: RefObject<boolean>
  follow: () => void
  snapshot: ScrollLayoutSnapshot | null
}

export function useTranscriptVirtualizer({
  segments,
  scrollElement,
  followsLatest,
  follow,
  snapshot
}: TranscriptVirtualizerOptions) {
  const [initial] = useState(() => initialVirtualLayout(segments, snapshot))
  const getScrollElement = useCallback(() => scrollElement, [scrollElement])
  const getItemKey = useCallback((index: number) => segments[index]!.key, [segments])
  return useVirtualizer({
    count: segments.length,
    getScrollElement,
    getItemKey,
    estimateSize: () => ESTIMATED_SEGMENT_HEIGHT,
    initialMeasurementsCache: initial.measurements,
    initialOffset: () =>
      followsLatest.current
        ? segments.length * ESTIMATED_SEGMENT_HEIGHT + TRANSCRIPT_TOP_PADDING
        : (initial.offset ?? scrollElement?.scrollTop ?? 0),
    overscan: 6,
    scrollMargin: TRANSCRIPT_TOP_PADDING,
    scrollToFn: (offset, options, instance) => {
      // The follow policy owns the full transcript bottom, including its plain live tail.
      if (followsLatest.current) follow()
      else elementScroll(offset, options, instance)
    },
    useFlushSync: false
  })
}
