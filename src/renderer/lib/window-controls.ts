import { platform } from './ipc'

/**
 * Titlebar room for the native window controls (tokens.css `--titlebar-inset-*`). The overlay's CSS geometry is
 * the truth whenever it reports one; until it does, the platform's estimate (traffic-light width on macOS, caption
 * button width on Windows and floating Linux, nothing on tiling Linux) reserves the space. Once the overlay reports
 * itself hidden (a macOS window in full screen) no controls cover the page, so nothing is reserved.
 */
export function trackWindowControls(): void {
  const root = document.documentElement
  const reserve = (shown: boolean) => {
    root.style.setProperty(
      '--titlebar-reserve-start',
      `${shown ? platform.titlebarInsetLeft : 0}px`
    )
    root.style.setProperty(
      '--titlebar-reserve-end',
      `${shown ? platform.captionButtonsWidth : 0}px`
    )
  }
  reserve(true)
  const overlay = navigator.windowControlsOverlay
  if (!overlay) return
  overlay.addEventListener('geometrychange', () => reserve(overlay.visible))
}
