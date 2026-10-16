/**
 * Onboarding: full-window first-run flow shown by the shell whenever no workspace is active.
 * Cinematic mark reveal → Engine detected → Connect a provider → Choose a project folder.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AnimatePresence,
  motion,
  useIsPresent,
  type HTMLMotionProps,
  type Variants
} from 'motion/react'
import { Check } from 'lucide-react'
import type { EngineId, EngineLocationInfo } from '@shared/api/engine'
import { cn } from '../../lib/cn'
import { invoke } from '../../lib/ipc'
import { spring } from '../../lib/motion'
import { useApp } from '../../store/app'
import { Mark, Skeleton } from '../../ui'
import { useSettings } from '../settings/store'
import { EnginePicker } from '../engines/EnginePicker'
import { useEngineRegistry } from '../engines/registry'
import { openWorkspace } from '../shell/workspace'
import { EngineStep, ProjectStep, ProviderStep } from './steps'

type Step = 0 | 1 | 2
const STEPS = ['Engine', 'Provider', 'Project'] as const
const WORDMARK = 'VENGEANCE'

const reveal: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.02, delayChildren: 0.15 } }
}
/** A card step. While it slides out over the next one (popLayout) it is inert and hidden from AT. */
function StepFrame(props: HTMLMotionProps<'div'>) {
  const present = useIsPresent()
  return <motion.div {...props} inert={!present} aria-hidden={present ? undefined : true} />
}

const letter: Variants = {
  hidden: { opacity: 0, y: 10, filter: 'blur(6px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: spring.smooth }
}

function MarkReveal({ compact }: { compact: boolean }) {
  return (
    <motion.div layout className="flex flex-col items-center" transition={spring.gentle}>
      <div className="relative flex items-center justify-center">
        <motion.div
          aria-hidden
          className="absolute size-[220px] rounded-full"
          style={{
            background:
              'radial-gradient(closest-side, color-mix(in oklab, var(--accent) 38%, transparent), transparent)'
          }}
          initial={{ opacity: 0, scale: 0.3 }}
          animate={{ opacity: [0, 0.9, 0.42], scale: [0.3, 1.25, 1] }}
          transition={{ duration: 1.6, times: [0, 0.4, 1], ease: [0.16, 1, 0.3, 1] }}
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.55, rotate: -10, filter: 'blur(14px)' }}
          animate={{ opacity: 1, scale: compact ? 0.72 : 1, rotate: 0, filter: 'blur(0px)' }}
          transition={spring.gentle}
        >
          <Mark size={76} glow />
        </motion.div>
      </div>
      <motion.div
        variants={reveal}
        initial="hidden"
        animate="show"
        className="mt-6 flex gap-[0.42em]"
        aria-label="Vengeance"
      >
        {WORDMARK.split('').map((ch, i) => (
          <motion.span
            key={i}
            variants={letter}
            className="text-[15px] leading-none font-semibold text-fg"
          >
            {ch}
          </motion.span>
        ))}
      </motion.div>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4, duration: 0.4 }}
        className="mt-2 text-sm text-fg-3"
      >
        Parallel coding agents, driven beautifully.
      </motion.p>
    </motion.div>
  )
}

function Stepper({
  step,
  done,
  onSelect
}: {
  step: Step
  done: boolean[]
  onSelect: (step: Step) => void
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      {STEPS.map((label, i) => {
        const active = i === step
        const complete = done[i]
        return (
          <div key={label} className="flex items-center gap-2">
            {i > 0 && (
              <div className="relative h-px w-10 overflow-hidden bg-hairline-strong">
                <motion.div
                  className={cn(
                    'absolute inset-0 origin-left',
                    done[i - 1] ? 'bg-success' : 'bg-fg-3'
                  )}
                  initial={false}
                  animate={{ scaleX: step >= i ? 1 : 0 }}
                  transition={spring.panel}
                />
              </div>
            )}
            <button
              type="button"
              disabled={i > step && !done[i - 1]}
              onClick={() => onSelect(i as Step)}
              className={cn(
                'flex h-7 items-center gap-2 rounded-full pr-3 pl-1 text-sm transition-colors disabled:cursor-default',
                active
                  ? 'bg-surface-3 text-fg shadow-[var(--highlight),0_0_0_1px_var(--hairline-strong)]'
                  : 'text-fg-3 enabled:hover:text-fg-2'
              )}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-2xs font-semibold tabular',
                  complete
                    ? 'bg-success-soft text-success'
                    : active
                      ? 'bg-active text-fg'
                      : 'bg-hover text-fg-4'
                )}
              >
                {complete ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              {label}
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Onboarding() {
  const engineId = useSettings((state) => state.engine)
  const selectEngine = useSettings((state) => state.selectDefaultEngine)
  const completedBefore = useApp((s) => s.prefs.onboardingCompleted)
  const update = useApp((s) => s.update)
  const catalog = useSettings((s) => s.catalog)
  const catalogLoading = useSettings((state) => state.catalogLoading)
  const loadCatalog = useSettings((s) => s.loadCatalog)
  const [engine, setEngine] = useState<EngineLocationInfo | null>(null)
  const [step, setStep] = useState<Step | null>(null)
  const [visited, setVisited] = useState<boolean[]>([false, false, false])
  const detectionRequest = useRef(0)

  const detect = useCallback(async () => {
    if (useSettings.getState().engine !== engineId) return
    const request = ++detectionRequest.current
    setEngine(null)
    try {
      const info = await invoke('engine:describe', engineId)
      if (request !== detectionRequest.current || useSettings.getState().engine !== engineId) return
      setEngine(info)
      void useEngineRegistry.getState().load(true)
      if (info.found) void loadCatalog(true)
    } catch (error) {
      if (request !== detectionRequest.current || useSettings.getState().engine !== engineId) return
      setEngine({
        engine: engineId,
        found: false,
        mock: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }, [engineId, loadCatalog])
  useEffect(() => {
    void detect()
    return () => {
      detectionRequest.current += 1
    }
  }, [detect])

  const ready = !!catalog?.providers.some((p) => p.status.configured)
  // Pick the first step once detection settles: returning users with a working setup go straight to the project.
  useEffect(() => {
    if (step !== null || !engine) return
    if (!engine.found) setStep(0)
    else if (completedBefore && catalog) setStep(ready ? 2 : 1)
    else if (completedBefore && !catalogLoading) setStep(1)
    else if (!completedBefore) setStep(0)
  }, [engine, catalog, catalogLoading, ready, completedBefore, step])

  const go = (next: Step) => {
    setVisited((v) => v.map((x, i) => x || i < next))
    setStep(next)
  }
  const done = [!!engine?.found, ready || !!visited[1], false]

  const open = (path: string) => {
    update({ onboardingCompleted: true })
    void openWorkspace(path, { engine: engineId })
  }

  const changeEngine = (next: EngineId) => {
    void selectEngine(next)
    setStep(0)
    setVisited([false, false, false])
  }

  return (
    <div className="relative flex h-full flex-1 flex-col items-center overflow-y-auto px-8">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_50%_0%,color-mix(in_oklab,var(--accent)_7%,transparent),transparent)]"
      />
      {/* Top-anchored (not centered) so the mark and stepper stay put while the card changes height between steps. */}
      <div className="relative flex w-full max-w-[540px] flex-1 flex-col pt-[10vh] pb-10">
        <MarkReveal compact={step !== null} />
        {/* The card frame is there from the first frame so the screen never reads as a loading splash. */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
          className="mt-9"
        >
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring.smooth, delay: 0.3 }}
          >
            <Stepper step={step ?? 0} done={done} onSelect={go} />
          </motion.div>
          {/* Relative: popLayout positions the leaving step inside the card, which clips its slide. */}
          <div className="relative mt-6 overflow-hidden rounded-lg bg-surface-2 p-6 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-lg)]">
            <EnginePicker
              value={engineId}
              onValueChange={changeEngine}
              label="Onboarding engine"
              className="mb-5 w-full"
            />
            {/* popLayout: the next step slides in while the previous one slides out, never after it. */}
            <AnimatePresence mode="popLayout" initial={false}>
              {step === null ? (
                <StepFrame
                  key="detecting"
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  aria-label="Looking for the engine"
                  className="flex items-center gap-3.5"
                >
                  <Skeleton className="size-10 rounded-card" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                </StepFrame>
              ) : (
                <StepFrame
                  key={`${engineId}:${step}`}
                  initial={{ opacity: 0, x: 18 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -18 }}
                  transition={spring.smooth}
                >
                  {step === 0 && (
                    <EngineStep
                      engine={engine}
                      engineId={engineId}
                      onRecheck={detect}
                      onNext={() => go(1)}
                    />
                  )}
                  {step === 1 && <ProviderStep onNext={() => go(2)} />}
                  {step === 2 && <ProjectStep onOpen={open} />}
                </StepFrame>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
