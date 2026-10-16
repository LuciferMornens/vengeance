import type { ReactNode } from 'react'
import { ContextMenu as RContext, DropdownMenu as RDropdown } from 'radix-ui'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '../lib/cn'
import { Kbd } from './Kbd'
import { listRowClass } from './ListRow'
import { floatingSurface } from './Popover'

/** Declarative menu model shared by DropdownMenu and ContextMenu. */
export type MenuItem =
  | {
      kind?: 'item'
      label: string
      icon?: ReactNode
      hotkey?: string
      danger?: boolean
      disabled?: boolean
      checked?: boolean
      onSelect: () => void
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  | { kind: 'submenu'; label: string; icon?: ReactNode; items: MenuItem[] }

const itemClass = cn(listRowClass({ density: 'menu' }), 'data-[state=open]:bg-hover data-[state=open]:text-fg [&_svg]:size-4 [&_svg]:text-fg-3 data-[highlighted]:[&_svg]:text-fg-2')

type Parts = typeof RDropdown | typeof RContext

function renderItems(P: Parts, items: MenuItem[]): ReactNode {
  return items.map((item, i) => {
    if (item.kind === 'separator') return <P.Separator key={i} className="mx-1 my-1 h-px bg-hairline" />
    if (item.kind === 'label')
      return (
        <P.Label key={i} className="px-2 pt-2 pb-1 text-xs font-medium text-fg-3">
          {item.label}
        </P.Label>
      )
    if (item.kind === 'submenu')
      return (
        <P.Sub key={i}>
          <P.SubTrigger className={itemClass}>
            {item.icon}
            <span className="flex-1">{item.label}</span>
            <ChevronRight className="!size-3.5" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent sideOffset={6} className={cn(floatingSurface, 'min-w-44')}>
              {renderItems(P, item.items)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      )
    return (
      <P.Item
        key={i}
        disabled={item.disabled}
        onSelect={item.onSelect}
        className={cn(itemClass, item.danger && 'text-danger hover:text-danger data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger [&_svg]:text-danger data-[highlighted]:[&_svg]:text-danger')}
      >
        {item.icon}
        <span className="flex-1 truncate">{item.label}</span>
        {item.checked && <Check className="!text-fg" />}
        {item.hotkey && <Kbd combo={item.hotkey} size="xs" />}
      </P.Item>
    )
  })
}

export interface DropdownMenuProps {
  trigger: ReactNode
  items: MenuItem[]
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

export function DropdownMenu({ trigger, items, align = 'start', side = 'bottom', className }: DropdownMenuProps) {
  return (
    <RDropdown.Root>
      <RDropdown.Trigger asChild>{trigger}</RDropdown.Trigger>
      <RDropdown.Portal>
        <RDropdown.Content align={align} side={side} sideOffset={6} collisionPadding={10} className={cn(floatingSurface, 'min-w-48', className)}>
          {renderItems(RDropdown, items)}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  )
}

export interface ContextMenuProps {
  items: MenuItem[]
  children: ReactNode
  className?: string
  onOpenChange?: (open: boolean) => void
}

export function ContextMenu({ items, children, className, onOpenChange }: ContextMenuProps) {
  return (
    <RContext.Root onOpenChange={onOpenChange}>
      <RContext.Trigger asChild>{children}</RContext.Trigger>
      <RContext.Portal>
        <RContext.Content collisionPadding={10} className={cn(floatingSurface, 'min-w-48', className)}>
          {renderItems(RContext, items)}
        </RContext.Content>
      </RContext.Portal>
    </RContext.Root>
  )
}
