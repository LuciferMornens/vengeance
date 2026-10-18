import { useEffect, useState } from 'react'

/** Narrowest center pane kept beside docked panels: the composer footer fits one row. */
const MIN_CENTER_WIDTH = 480

/** Center pane left visible beside an overlaid inspector, so the overlay reads as a drawer. */
const OVERLAY_GUTTER = 64

/** Resize settling time: panel widths follow the window without spring lag until it passes. */
const RESIZE_SETTLE_MS = 160

export interface PanelSpec {
  open: boolean
  /** Preferred width (px), as the user left it. */
  width: number
  minWidth: number
  maxWidth: number
}

export interface PanelFit {
  /** Width actually drawn, never above the preference. */
  width: number
  /** Widest the divider may drag to in this window. */
  maxWidth: number
}

export interface PanelLayout {
  sidebar: PanelFit
  inspector: PanelFit
  /** The inspector floats over the center pane instead of docking beside it. */
  inspectorOverlay: boolean
}

/**
 * The minimum wins over the maximum: a window narrower than the minimum layout (a tiling compositor ignores the
 * window's minimum size) keeps the panels at their minimum widths and the center pane gives way.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)))
}

/**
 * Fit both panels into `total` px while the center pane keeps MIN_CENTER_WIDTH: shrink the
 * inspector toward its minimum first, then the sidebar. When even both minimums leave too little,
 * the inspector becomes an overlay.
 */
export function fitPanels(total: number, sidebar: PanelSpec, inspector: PanelSpec): PanelLayout {
  const room = total - MIN_CENTER_WIDTH
  const sidebarWidth = clamp(sidebar.width, sidebar.minWidth, sidebar.maxWidth)
  const inspectorWidth = clamp(inspector.width, inspector.minWidth, inspector.maxWidth)
  const sidebarMin = sidebar.open ? sidebar.minWidth : 0
  const docks = !inspector.open || sidebarMin + inspector.minWidth <= room

  if (!docks) {
    const sidebarMax = Math.max(sidebar.minWidth, Math.min(sidebar.maxWidth, room))
    const overlayMax = Math.max(
      inspector.minWidth,
      Math.min(inspector.maxWidth, total - OVERLAY_GUTTER)
    )
    return {
      sidebar: { width: Math.min(sidebarWidth, sidebarMax), maxWidth: sidebarMax },
      inspector: { width: Math.min(inspectorWidth, overlayMax), maxWidth: overlayMax },
      inspectorOverlay: true
    }
  }

  // The sidebar keeps its width while the inspector can still shrink; `docks` keeps both at or
  // above their minimums.
  const sidebarKept = sidebar.open ? Math.min(sidebarWidth, room - inspector.minWidth) : 0
  const inspectorMax = Math.min(inspector.maxWidth, room - sidebarKept)
  const inspectorFitted = clamp(inspectorWidth, inspector.minWidth, inspectorMax)
  const sidebarMax = Math.min(sidebar.maxWidth, room - (inspector.open ? inspectorFitted : 0))
  const sidebarFitted = clamp(sidebarWidth, sidebar.minWidth, sidebarMax)
  const inspectorDragMax = Math.min(inspector.maxWidth, room - (sidebar.open ? sidebarFitted : 0))
  return {
    sidebar: { width: sidebarFitted, maxWidth: Math.max(sidebar.minWidth, sidebarMax) },
    inspector: {
      width: inspectorFitted,
      maxWidth: Math.max(inspector.minWidth, inspectorDragMax)
    },
    inspectorOverlay: false
  }
}

/** The window's inner width, and whether it is being resized right now. */
export function useWindowWidth(): { width: number; resizing: boolean } {
  const [width, setWidth] = useState(() => window.innerWidth)
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      setWidth(window.innerWidth)
      setResizing(true)
      clearTimeout(settle)
      settle = setTimeout(() => setResizing(false), RESIZE_SETTLE_MS)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(settle)
    }
  }, [])
  return { width, resizing }
}
