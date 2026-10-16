import { MotionConfig } from 'motion/react'
import { AppShell } from './features/shell'
import { CommandPalette } from './features/palette'
import { ExtensionUiHost } from './features/extension-ui'
import { LaunchHost } from './features/launch'
import { useReducedMotionMode } from './features/settings/motion'
import { useApp } from './store/app'
import { Toaster, TooltipProvider } from './ui'

export function App() {
  const ready = useApp((s) => s.ready)
  const reducedMotion = useReducedMotionMode()
  return (
    <MotionConfig reducedMotion={reducedMotion}>
      <TooltipProvider>
        {ready && (
          <>
            <AppShell />
            <CommandPalette />
            <ExtensionUiHost />
            <LaunchHost />
          </>
        )}
        <Toaster />
      </TooltipProvider>
    </MotionConfig>
  )
}
