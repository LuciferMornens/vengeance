import { useEffect } from 'react'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import { Select } from 'radix-ui'
import { ENGINE_LABELS, type EngineId } from '@shared/api/engine'
import { cn } from '../../lib/cn'
import { floatingSurface } from '../../ui'
import { useEngineRegistry } from './registry'

interface EnginePickerProps {
  value: EngineId
  onValueChange: (engine: EngineId) => void
  label?: string
  className?: string
  disabled?: boolean
}

const ENGINE_IDS: EngineId[] = ['pi', 'prime']

export function EnginePicker({
  value,
  onValueChange,
  label = 'Choose engine',
  className,
  disabled = false
}: EnginePickerProps) {
  const locations = useEngineRegistry((state) => state.locations)
  const loading = useEngineRegistry((state) => state.loading)
  useEffect(() => {
    void useEngineRegistry.getState().load()
  }, [])

  return (
    <Select.Root
      value={value}
      disabled={disabled}
      onValueChange={(engine) => onValueChange(engine as EngineId)}
    >
      <Select.Trigger
        aria-label={label}
        className={cn(
          'no-drag flex h-9 items-center gap-2 rounded-md bg-surface-2 px-3 text-ui text-fg',
          'shadow-[inset_0_0_0_1px_var(--hairline)] transition-colors hover:bg-surface-3',
          'focus-visible:shadow-focus disabled:opacity-50',
          className
        )}
      >
        <Cpu className="size-4 shrink-0 text-fg-3" />
        <Select.Value />
        <Select.Icon className="ml-auto">
          <ChevronDown className="size-3.5 text-fg-3" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className={cn(floatingSurface, 'min-w-[240px] p-1')}
        >
          <Select.Viewport>
            {ENGINE_IDS.map((engine) => {
              const location = locations[engine]
              const status = location?.found
                ? location.version
                  ? `Installed · ${location.version}`
                  : 'Installed'
                : loading
                  ? 'Checking installation…'
                  : 'Set up this engine'
              return (
                <Select.Item
                  key={engine}
                  value={engine}
                  className="relative flex cursor-default items-center gap-3 rounded-sm px-2.5 py-2 text-fg-2 outline-none data-[highlighted]:bg-hover data-[highlighted]:text-fg"
                >
                  <Cpu className="size-4 shrink-0 text-fg-3" />
                  <div className="min-w-0 flex-1">
                    <Select.ItemText>{ENGINE_LABELS[engine]}</Select.ItemText>
                    <div className="mt-0.5 text-xs text-fg-3">{status}</div>
                  </div>
                  <Select.ItemIndicator>
                    <Check className="size-3.5" />
                  </Select.ItemIndicator>
                </Select.Item>
              )
            })}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
