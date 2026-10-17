/// <reference types="vite/client" />
import type { VengeanceBridge } from '@shared/ipc'
import type { VengeanceTestHook } from './lib/test-hook'

declare global {
  interface Window {
    vengeance: VengeanceBridge
    __vengeanceTest?: VengeanceTestHook
  }

  /** Chromium's Window Controls Overlay (not in TypeScript's DOM library yet); fires `geometrychange`. */
  interface WindowControlsOverlay extends EventTarget {
    /** False while the window draws no controls over the page. */
    readonly visible: boolean
  }

  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay
  }
}
