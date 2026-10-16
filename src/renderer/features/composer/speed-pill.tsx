import { DropdownMenu as RDropdown } from 'radix-ui'
import { Check, ChevronDown, Info, Zap } from 'lucide-react'
import type { SpeedMode, SpeedState } from '@shared/api/speed'
import { cn } from '../../lib/cn'
import { useAgents } from '../../store/agents'
import { floatingSurface, listRowClass, Spinner, Tooltip } from '../../ui'
import {
  formatSpeedPrice,
  hasSpeedControl,
  setSpeed,
  SPEED_LABELS,
  findSpeedOption,
  speedDescription,
  usePendingSpeed
} from './speed'

const pillClass = cn(
  'no-drag pressable inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap',
  'transition-colors duration-[var(--dur-instant)]'
)
const fasterPillClass =
  'bg-accent-softer text-accent-text hover:bg-accent-soft data-[state=open]:bg-accent-soft'
const standardPillClass = cn(
  'text-fg-3 hover:bg-hover hover:text-fg-2',
  'data-[state=open]:bg-active data-[state=open]:text-fg'
)

/** Zap glyph: outline at standard speed, filled with the accent for the faster modes. */
function SpeedGlyph({ mode, className }: { mode: SpeedMode; className?: string }) {
  return (
    <Zap
      className={cn('size-3.5 shrink-0', className)}
      fill={mode === 'standard' ? 'none' : 'currentColor'}
      fillOpacity={mode === 'ultrafast' ? 1 : 0.25}
    />
  )
}

/** Why the session runs slower than it asked for, e.g. Ultrafast on a model with only Fast. */
function fallbackNote(speed: SpeedState): string | undefined {
  if (speed.requested === speed.effective) return undefined
  const requested = SPEED_LABELS[speed.requested]
  return `This model has no ${requested}, so the session runs at ${SPEED_LABELS[speed.effective]}.`
}

/** Composer footer pill for the response speed; its menu lists the offered speeds with prices. */
export function SpeedPill({ agentId }: { agentId: string }) {
  const speed = useAgents((state) => state.agents[agentId]?.speed)
  const ready = useAgents((state) => state.agents[agentId]?.status === 'ready')
  const pending = usePendingSpeed((state) => state[agentId])
  if (!hasSpeedControl(speed)) return null

  if (speed.options.length === 0)
    return (
      <Tooltip content={speed.unavailableReason} side="top">
        <button
          type="button"
          aria-label={`Speed: Unavailable. ${speed.unavailableReason}`}
          aria-disabled
          className={cn(pillClass, 'cursor-default text-fg-4')}
        >
          <SpeedGlyph mode="standard" />
        </button>
      </Tooltip>
    )

  const faster = speed.effective !== 'standard'
  const note = fallbackNote(speed)
  const modes: SpeedMode[] = ['standard', ...speed.options.map((option) => option.mode)]
  // A requested mode the model lacks (Ultrafast on a Fast model) checks the mode in use instead.
  const checked = modes.includes(speed.requested) ? speed.requested : speed.effective

  return (
    <RDropdown.Root>
      <Tooltip content={note ?? 'Response speed'} side="top">
        <RDropdown.Trigger asChild>
          <button
            type="button"
            aria-label={`Speed: ${SPEED_LABELS[speed.effective]}`}
            aria-busy={!!pending}
            disabled={!ready}
            className={cn(pillClass, faster ? fasterPillClass : standardPillClass)}
          >
            <span className="relative inline-flex">
              <SpeedGlyph mode={speed.effective} className={pending ? 'invisible' : undefined} />
              {pending && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Spinner size={11} />
                </span>
              )}
            </span>
            {faster && (
              <span className="@max-[40em]/composer:hidden">{SPEED_LABELS[speed.effective]}</span>
            )}
            {faster && <ChevronDown className="size-3 shrink-0 opacity-60" />}
          </button>
        </RDropdown.Trigger>
      </Tooltip>
      <RDropdown.Portal>
        <RDropdown.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          className={cn(floatingSurface, 'w-[300px] p-1.5')}
        >
          <RDropdown.Label className="flex h-7 items-center px-2.5 text-xs font-medium text-fg-3">
            Response speed
          </RDropdown.Label>
          <RDropdown.RadioGroup
            value={checked}
            onValueChange={(next) => void setSpeed(agentId, next as SpeedMode)}
          >
            {modes.map((mode) => {
              const option = findSpeedOption(speed, mode)
              const price = formatSpeedPrice(option)
              const active = mode === checked
              return (
                <RDropdown.RadioItem
                  key={mode}
                  value={mode}
                  className={cn(listRowClass({ density: 'list' }), 'cursor-default')}
                >
                  <span
                    className={cn(
                      'flex w-6 shrink-0 justify-center',
                      mode === 'standard' ? 'text-fg-3' : 'text-accent-text'
                    )}
                  >
                    <SpeedGlyph mode={mode} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn('truncate', active ? 'font-medium text-fg' : undefined)}>
                      {SPEED_LABELS[mode]}
                    </span>
                    <span className="truncate text-xs text-fg-3">
                      {speedDescription(mode, option)}
                    </span>
                  </span>
                  {price && <span className="tabular shrink-0 text-xs text-fg-3">{price}</span>}
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <RDropdown.ItemIndicator>
                      <Check className="size-3.5 text-fg" strokeWidth={2.5} />
                    </RDropdown.ItemIndicator>
                  </span>
                </RDropdown.RadioItem>
              )
            })}
          </RDropdown.RadioGroup>
          {note && (
            <p
              className={cn(
                'mx-1 mt-1 flex gap-2 border-t border-hairline-soft px-1.5 pt-2 pb-1',
                'text-xs leading-snug text-fg-3'
              )}
            >
              <Info className="mt-px size-3.5 shrink-0" />
              {note}
            </p>
          )}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  )
}
