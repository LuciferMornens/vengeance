import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles/globals.css'
import { lazy, StrictMode, Suspense, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startSpeedTracking } from './features/composer/speed'
import { startPrimeSideQuestionEvents } from './features/engines/prime-side-questions'
import { platform } from './lib/ipc'
import { installTestHook } from './lib/test-hook'
import { trackWindowControls } from './lib/window-controls'
import { startAgentEventPump } from './store/agents'
import { useApp } from './store/app'
import { Toaster, TooltipProvider } from './ui'

document.documentElement.dataset.material = platform.material
trackWindowControls()
startAgentEventPump()
window.addEventListener('pagehide', startPrimeSideQuestionEvents(), { once: true })
window.addEventListener('pagehide', startSpeedTracking(), { once: true })
if (platform.test) installTestHook()
void useApp.getState().load()

/** Dev/test-only primitives gallery at `#design` (never reachable in a packaged, non-test build). */
const GALLERY_ENABLED = import.meta.env.DEV || platform.test
const DesignGallery = lazy(() =>
  import('./ui/gallery/DesignGallery').then((m) => ({ default: m.DesignGallery }))
)

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function Root() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  if (GALLERY_ENABLED && hash === '#design') {
    return (
      <TooltipProvider>
        <Suspense fallback={null}>
          <DesignGallery />
        </Suspense>
        <Toaster />
      </TooltipProvider>
    )
  }
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
