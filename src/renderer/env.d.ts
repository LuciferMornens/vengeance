/// <reference types="vite/client" />
import type { VengeanceBridge } from '@shared/ipc'
import type { VengeanceTestHook } from './lib/test-hook'

declare global {
  interface Window {
    vengeance: VengeanceBridge
    __vengeanceTest?: VengeanceTestHook
  }
}
