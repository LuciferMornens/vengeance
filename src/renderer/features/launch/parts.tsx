import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, File, FolderOpen, Plus, X } from 'lucide-react'
import type { EngineId } from '@shared/api/engine'
import type { PrimeLaunchOptions } from '@shared/api/launch'
import { cn } from '../../lib/cn'
import { invoke } from '../../lib/ipc'
import { Button, Dialog, Input, Kbd, Tooltip } from '../../ui'
import { Collapse } from '../../ui/Collapse'
import { CopyButton } from '../../ui/CopyButton'
import { formatEngineArgs } from './options'

/** Building blocks of the launch dialogs (Trust, Launch options): frame, grouped rows, tag and path editors. */

export interface LaunchDialogFrameProps {
  /** False plays the close animation (keep the frame mounted while it runs). */
  open: boolean
  title: ReactNode
  description?: ReactNode
  icon: ReactNode
  width: number
  /** Classes for the body, e.g. a fixed height so switching sections never makes the dialog jump. */
  bodyClassName?: string
  children: ReactNode
  footer?: ReactNode
  /** Left side of the footer (replaces `hints`). */
  footerStart?: ReactNode
  /** Key hints: `combo` uses keybinding syntax (`mod+enter`), `keys` are literal caps (arrows). */
  hints?: Array<{ combo?: string; keys?: string[]; label: string }>
  /** Esc / close. */
  onDismiss(): void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

/**
 * The launch dialogs' preset of the shared <Dialog>: persistent (outside clicks never lose a decision or a draft),
 * an edge-to-edge body under a hairline, and key hints on the left of the footer. Focus starts on `[data-autofocus]`.
 */
export function LaunchDialogFrame({
  open,
  title,
  description,
  icon,
  width,
  bodyClassName,
  children,
  footer,
  footerStart,
  hints,
  onDismiss,
  onKeyDown
}: LaunchDialogFrameProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onDismiss()}
      persistent
      title={title}
      description={description}
      icon={icon}
      width={width}
      onKeyDown={onKeyDown}
      footer={footer}
      footerStart={footerStart ?? (hints && <KeyHints hints={hints} />)}
      bodyClassName={cn('flex flex-col border-y border-hairline-soft px-0 pb-0', bodyClassName)}
    >
      {children}
    </Dialog>
  )
}

function KeyHints({ hints }: { hints: NonNullable<LaunchDialogFrameProps['hints']> }) {
  return hints.map((hint) => (
    <span key={hint.label} className="inline-flex items-center gap-1.5">
      {hint.combo ? <Kbd combo={hint.combo} size="xs" /> : <KeyCaps keys={hint.keys ?? []} />}
      {hint.label}
    </span>
  ))
}

function KeyCaps({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key) => (
        <kbd
          key={key}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-xs bg-hover px-1 font-sans text-2xs font-medium text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline),inset_0_-1px_0_var(--hairline)]"
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}

/**
 * The engine flags a session starts with, as data behind a collapsed "Show engine command" disclosure (Launch options,
 * inspector Overview): the UI talks in options, the command line is there for whoever wants to copy it.
 */
export function EngineCommand({
  args,
  envKeys,
  engine = 'pi',
  configuration,
  className
}: {
  args: string[]
  envKeys: string[]
  engine?: EngineId
  configuration?: PrimeLaunchOptions
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const native = engine === 'prime'
  const display = native
    ? configuration
      ? JSON.stringify(configuration, null, 2)
      : ''
    : formatEngineArgs(args)
  const label = native ? 'launch configuration' : 'engine command'
  return (
    <div className={className}>
      <div className="flex h-7 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 inline-flex h-6 items-center gap-1 rounded-sm px-1 text-xs font-medium text-fg-3 transition-colors duration-[var(--dur-instant)] hover:text-fg-2 focus-visible:text-fg-2 focus-visible:outline-none"
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform duration-[var(--dur-fast)]',
              open && 'rotate-90'
            )}
          />
          {`${open ? 'Hide' : 'Show'} ${label}`}
        </button>
        <span className="min-w-0 flex-1" />
        {display && <CopyButton value={display} label={`Copy ${label}`} />}
      </div>
      <Collapse open={open}>
        <div
          data-testid="engine-arguments"
          className={cn(
            'selectable mt-1 max-h-[96px] overflow-y-auto rounded-md bg-surface-1 px-2.5 py-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] text-fg-2 shadow-elev-0',
            native && 'whitespace-pre-wrap'
          )}
        >
          {!display ? (
            <span className="font-sans text-fg-3">
              {native
                ? 'No startup overrides. The engine uses its saved settings.'
                : 'No extra flags. The engine starts with its defaults.'}
            </span>
          ) : (
            display
          )}
          {envKeys.length > 0 && (
            <div className="mt-1 font-sans text-fg-3">Environment: {envKeys.join(', ')}</div>
          )}
        </div>
      </Collapse>
    </div>
  )
}

export function Group({
  title,
  description,
  actions,
  children,
  className
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('mb-6 last:mb-0', className)}>
      {(title || actions) && (
        <div className="mb-2 flex items-end gap-3 px-1">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-xs font-medium text-fg-3">{title}</h3>}
            {description && <p className="mt-0.5 text-sm leading-snug text-fg-3">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="rounded-card bg-surface-1 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
        {children}
      </div>
    </section>
  )
}

export function Row({
  label,
  description,
  children,
  below,
  className
}: {
  label: ReactNode
  description?: ReactNode
  children?: ReactNode
  below?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('border-b border-hairline-soft px-3.5 py-3 last:border-b-0', className)}>
      <div className="flex items-center gap-5">
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-fg">{label}</div>
          {description && (
            <div className="mt-0.5 text-sm leading-snug text-fg-3">{description}</div>
          )}
        </div>
        {children !== undefined && (
          <div className="flex shrink-0 items-center justify-end">{children}</div>
        )}
      </div>
      {below && <div className="mt-2.5">{below}</div>}
    </div>
  )
}

/** Single-line note inside or under a group. */
export function Note({
  icon,
  children,
  tone = 'neutral',
  className
}: {
  icon?: ReactNode
  children: ReactNode
  tone?: 'neutral' | 'warning'
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 text-sm leading-relaxed [&>svg]:mt-[3px] [&>svg]:size-3.5 [&>svg]:shrink-0',
        tone === 'warning' ? 'text-warning' : 'text-fg-3',
        className
      )}
    >
      {icon}
      <div className="min-w-0 flex-1 text-fg-3">{children}</div>
    </div>
  )
}

export interface TagSuggestion {
  value: string
  description?: string
}

/** Free-form list editor: Enter/comma adds, Backspace on empty removes the last tag, suggestions add on click. */
export function TagInput({
  values,
  onChange,
  placeholder,
  suggestions,
  mono = true,
  'aria-label': label
}: {
  values: string[]
  onChange(values: string[]): void
  placeholder: string
  suggestions?: TagSuggestion[]
  mono?: boolean
  'aria-label': string
}) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && !values.includes(p))
    if (parts.length > 0) onChange([...values, ...parts])
    setDraft('')
  }
  const open = (suggestions ?? []).filter((s) => !values.includes(s.value))
  return (
    <div>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-1 shadow-[var(--highlight),0_0_0_1px_var(--hairline)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--fg)_24%,transparent),0_0_0_4px_var(--hover)]">
        {values.map((value) => (
          <span
            key={value}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-sm bg-surface-4 pr-0.5 pl-2 text-fg shadow-[inset_0_0_0_1px_var(--hairline)]',
              mono ? 'font-mono text-xs' : 'text-sm'
            )}
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
              className="flex size-5 items-center justify-center rounded-xs text-fg-3 hover:bg-active hover:text-fg"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          aria-label={label}
          placeholder={values.length === 0 ? placeholder : ''}
          onChange={(e) =>
            e.target.value.endsWith(',') ? add(e.target.value) : setDraft(e.target.value)
          }
          onBlur={() => draft.trim() && add(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault()
              e.stopPropagation()
              add(draft)
            } else if (e.key === 'Backspace' && !draft && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
          className={cn(
            'h-6 min-w-[140px] flex-1 bg-transparent px-1 text-fg outline-none placeholder:text-fg-3',
            mono ? 'font-mono text-xs' : 'text-ui'
          )}
        />
      </div>
      {open.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {open.map((s) => (
            <Tooltip key={s.value} content={s.description ?? s.value}>
              <button
                type="button"
                onClick={() => onChange([...values, s.value])}
                className="inline-flex h-6 items-center gap-1 rounded-sm px-1.5 font-mono text-xs text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)] transition-colors hover:bg-hover hover:text-fg"
              >
                <Plus className="size-3" />
                {s.value}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}

/** Ordered list of paths (or builtin names) with file/folder pickers and a free-text entry. */
export function PathList({
  values,
  onChange,
  placeholder,
  cwd,
  allowFolders = true,
  filters
}: {
  values: string[]
  onChange(values: string[]): void
  placeholder: string
  cwd: string
  allowFolders?: boolean
  filters?: Array<{ name: string; extensions: string[] }>
}) {
  const [draft, setDraft] = useState('')
  const add = (items: string[]) => {
    const next = items.map((v) => v.trim()).filter((v) => v && !values.includes(v))
    if (next.length > 0) onChange([...values, ...next])
  }
  const pickFiles = async () =>
    add(await invoke('sys:pick-files', { defaultPath: cwd, multiple: true, filters }))
  const pickFolder = async () => {
    const folder = await invoke('sys:pick-folder', { defaultPath: cwd })
    if (folder) add([folder])
  }
  return (
    <div className="space-y-1.5">
      {values.map((value) => (
        <div
          key={value}
          className="group/path flex h-8 items-center gap-2 rounded-md bg-surface-2 pr-1 pl-2.5 shadow-[inset_0_0_0_1px_var(--hairline-soft)]"
        >
          {/[\\/]|\.\w+$/.test(value) ? (
            <File className="size-3.5 shrink-0 text-fg-3" />
          ) : (
            <Plus className="size-3.5 shrink-0 text-fg-3" />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={value}>
            {value}
          </span>
          <button
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => onChange(values.filter((v) => v !== value))}
            className="flex size-6 items-center justify-center rounded-sm text-fg-3 opacity-60 transition-opacity group-hover/path:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          inputSize="sm"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault()
              e.stopPropagation()
              add([draft])
              setDraft('')
            }
          }}
          className={'min-w-0 flex-1 font-mono text-xs'}
        />
        <Button size="sm" variant="ghost" leading={<File />} onClick={() => void pickFiles()}>
          File…
        </Button>
        {allowFolders && (
          <Button
            size="sm"
            variant="ghost"
            leading={<FolderOpen />}
            onClick={() => void pickFolder()}
          >
            Folder…
          </Button>
        )}
      </div>
    </div>
  )
}
