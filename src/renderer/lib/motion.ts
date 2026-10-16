import type { Transition, Variants } from 'motion/react'

/** Spring presets — keep motion consistent across features. Never inline a spring config. */
export const spring = {
  /** Small UI elements: buttons, chips, toggles, indicators, toasts. */
  snappy: { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 },
  /** Popovers, menus, dialogs, tab content. */
  smooth: { type: 'spring', stiffness: 380, damping: 34, mass: 0.8 },
  /** Panels and sheets (sidebar, inspector, settings). */
  panel: { type: 'spring', stiffness: 300, damping: 34, mass: 0.9 },
  /** Layout changes (tool cards expanding, list reflow). */
  layout: { type: 'spring', stiffness: 420, damping: 40 },
  /** Hero and first-run moments (onboarding mark, empty-state hero). */
  gentle: { type: 'spring', stiffness: 220, damping: 28, mass: 1 }
} satisfies Record<string, Transition>

export const ease = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1]
} as const

/** Seconds; mirrors the --dur-* CSS tokens. */
export const duration = { instant: 0.08, fast: 0.12, base: 0.18, panel: 0.26, slow: 0.42 } as const

/** `whileTap` for buttons and pills (never rows). Mirrors the .pressable CSS utility. */
export const press = { scale: 0.97 } as const

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: duration.base, ease: ease.out } },
  exit: { opacity: 0, y: 4, transition: { duration: duration.fast, ease: ease.out } }
}

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  show: { opacity: 1, scale: 1, transition: spring.smooth },
  exit: { opacity: 0, scale: 0.98, transition: { duration: duration.fast, ease: ease.out } }
}

/** Parent variant that staggers children using fadeUp. */
export const stagger = (step = 0.035): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: step } }
})
