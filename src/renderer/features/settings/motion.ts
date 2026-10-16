import { useApp } from '../../store/app'
import './motion.css'

/** App-wide motion preference: `data-motion` on <html> for CSS, and the MotionConfig mode for springs. */

function apply(): void {
  const reduce = useApp.getState().prefs.features.settings?.motion === 'reduce'
  if (reduce) document.documentElement.dataset.motion = 'reduce'
  else delete document.documentElement.dataset.motion
}

apply()
useApp.subscribe((state, previous) => {
  if (state.prefs.features.settings?.motion !== previous.prefs.features.settings?.motion) apply()
})

/** `reducedMotion` for <MotionConfig>: "user" follows the OS, "always" forces reduced springs. */
export function useReducedMotionMode(): 'user' | 'always' {
  return useApp((s) => (s.prefs.features.settings?.motion === 'reduce' ? 'always' : 'user'))
}
