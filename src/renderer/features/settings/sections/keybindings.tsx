import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, FolderOpen, Plus, Search, X } from 'lucide-react'
import type { KeybindingAction, KeybindingsState } from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import { platform } from '../../../lib/ipc'
import { invoke, on } from '../ipc'
import { composedKey, KEY_CAPTURE_ATTRIBUTE, keyFromCode } from '../../../lib/keybindings'
import { Badge, Button, Input, Kbd, Skeleton, toast, Tooltip } from '../../../ui'
import { FOCUS_RING } from '../controls'
import { Group, Highlight, KeyHint, Note, Row, SearchQueryContext } from '../layout'
import { keyConflicts } from './keybinding-conflicts'

/** keybindings.json for the engine's terminal UI (pi docs/keybindings.md): see and reassign every action. */

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Escape: 'escape',
  Enter: 'enter',
  Tab: 'tab',
  ' ': 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  Clear: 'clear'
}

/** A keydown in pi's key syntax (`ctrl+shift+x`), or null for a lone modifier. */
function comboFromEvent(event: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) return null
  let key =
    NAMED_KEYS[event.key] ??
    (/^F([1-9]|1[0-2])$/.test(event.key) ? event.key.toLowerCase() : event.key)
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(event.code) && !event.shiftKey) key = event.code.slice(5)
  // Option on macOS composes another character (⌥, is ≤); pi reads it as alt plus the physical key.
  else if (platform.os === 'darwin' && event.altKey && composedKey(event.key)) key = keyFromCode(event.code) ?? key
  if (key.length === 1) key = key.toLowerCase()
  const modifiers = [
    event.ctrlKey && 'ctrl',
    event.shiftKey && 'shift',
    event.altKey && 'alt',
    event.metaKey && 'super'
  ].filter(Boolean)
  return [...modifiers, key].join('+')
}

function KeyChip({ combo, onRemove }: { combo: string; onRemove: () => void }) {
  return (
    <span
      className="group/key inline-flex h-6 items-center gap-0.5 rounded-sm pl-0.5 transition-colors hover:bg-hover"
      title={combo}
    >
      <Kbd combo={combo} />
      <button
        type="button"
        aria-label={`Remove ${combo}`}
        onClick={onRemove}
        className={cn(
          'flex size-5 items-center justify-center rounded-xs text-fg-3 opacity-60 group-hover/key:opacity-100 hover:bg-active hover:text-fg focus-visible:opacity-100',
          FOCUS_RING
        )}
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function KeyCapture({
  onCapture,
  onCancel
}: {
  onCapture: (combo: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const handlers = useRef({ onCapture, onCancel })
  handlers.current = { onCapture, onCancel }
  useEffect(() => {
    const element = ref.current
    element?.focus()
    // Window, capture phase: ahead of the sheet's Escape (Radix, document) so every key while recording belongs here.
    // Vengeance's own hotkeys stand aside for KEY_CAPTURE_ATTRIBUTE (useHotkey).
    const listener = (event: KeyboardEvent) => {
      if (event.target !== element) return
      event.preventDefault()
      event.stopPropagation()
      if (
        event.key === 'Escape' &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey
      )
        return handlers.current.onCancel()
      const combo = comboFromEvent(event)
      if (combo) handlers.current.onCapture(combo)
    }
    window.addEventListener('keydown', listener, { capture: true })
    return () => window.removeEventListener('keydown', listener, { capture: true })
  }, [])
  return (
    <span
      ref={ref}
      {...{ [KEY_CAPTURE_ATTRIBUTE]: '' }}
      role="textbox"
      tabIndex={0}
      aria-label="Press a key combination"
      onBlur={onCancel}
      className={cn(
        'inline-flex h-6 items-center rounded-sm bg-surface-1 px-2 text-xs text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline-strong)] outline-none',
        FOCUS_RING
      )}
    >
      Press keys… <span className="ml-1.5 text-fg-3">Esc cancels</span>
    </span>
  )
}

function ActionRow({
  action,
  keys,
  custom,
  conflictsWith,
  onChange
}: {
  action: KeybindingAction
  keys: string[]
  custom: boolean
  /** Descriptions of the other actions sharing one of these keys. */
  conflictsWith: string[]
  onChange: (keys: string[] | undefined) => void
}) {
  const [capturing, setCapturing] = useState(false)
  return (
    <Row
      settingKey={`keybinding.${action.id}`}
      label={
        <Tooltip content={<span className="font-mono">{action.id}</span>}>
          <span>{action.description}</span>
        </Tooltip>
      }
      description={
        conflictsWith.length > 0 ? `Also used by ${conflictsWith.join(', ')}` : undefined
      }
      badges={
        <>
          {custom &&
            (keys.length === 0 ? <Badge tone="warning">Disabled</Badge> : <Badge>Custom</Badge>)}
          {conflictsWith.length > 0 && <Badge tone="warning">Conflict</Badge>}
        </>
      }
      onReset={custom ? () => onChange(undefined) : undefined}
      resetLabel="Restore default keys"
    >
      <div className="flex max-w-[320px] flex-wrap items-center justify-end gap-1.5">
        {keys.length === 0 && !capturing && <span className="text-sm text-fg-3">Unassigned</span>}
        {keys.map((combo) => (
          <KeyChip
            key={combo}
            combo={combo}
            onRemove={() => onChange(keys.filter((k) => k !== combo))}
          />
        ))}
        {capturing ? (
          <KeyCapture
            onCancel={() => setCapturing(false)}
            onCapture={(combo) => {
              setCapturing(false)
              if (!keys.includes(combo)) onChange([...keys, combo])
            }}
          />
        ) : (
          <button
            type="button"
            aria-label={`Add a key for ${action.description}`}
            onClick={() => setCapturing(true)}
            className="flex size-6 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-hover hover:text-fg"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
    </Row>
  )
}

export function KeybindingsSection() {
  const [state, setState] = useState<KeybindingsState | null>(null)
  const [query, setQuery] = useState('')
  const load = useCallback(() => void invoke('settings:keybindings').then(setState), [])
  useEffect(() => {
    load()
    return on('settings:changed', ({ area }) => area === 'keybindings' && load())
  }, [load])

  const conflicts = useMemo(() => {
    if (!state) return new Map<string, string[]>()
    const descriptions = new Map(state.actions.map((action) => [action.id, action.description]))
    const byAction = keyConflicts(state.actions, state.bindings)
    return new Map(
      [...byAction].map(([id, others]) => [
        id,
        others.map((other) => descriptions.get(other) ?? other)
      ])
    )
  }, [state])

  const groups = useMemo(() => {
    if (!state) return []
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches = (action: KeybindingAction) => {
      const keys = (state.bindings[action.id] ?? action.defaults).join(' ')
      const haystack = `${action.description} ${action.id} ${keys}`.toLowerCase()
      return terms.every((t) => haystack.includes(t))
    }
    const byGroup = new Map<string, KeybindingAction[]>()
    for (const action of state.actions.filter(matches))
      byGroup.set(action.group, [...(byGroup.get(action.group) ?? []), action])
    return [...byGroup.entries()]
  }, [state, query])

  const change = async (id: string, keys: string[] | undefined) => {
    if (!state) return
    const { [id]: _previous, ...rest } = state.bindings
    const bindings = keys === undefined ? rest : { ...rest, [id]: keys }
    setState({ ...state, bindings })
    try {
      setState(await invoke('settings:keybindings-write', bindings))
    } catch (error) {
      toast({
        level: 'error',
        title: 'Keybinding not saved',
        description: (error as Error).message
      })
      load()
    }
  }

  if (!state) {
    return (
      <Group>
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
      </Group>
    )
  }
  const customCount = Object.keys(state.bindings).length
  return (
    <>
      <div className="mb-5 flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter actions or keys"
          leading={<Search />}
          spellCheck={false}
          className="w-72"
        />
        <span className="flex-1 text-sm text-fg-3">
          {customCount ? `${customCount} customized` : 'All defaults'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          leading={<FolderOpen />}
          onClick={() => void invoke('sys:reveal', state.path)}
        >
          Reveal
        </Button>
      </div>
      {state.error && (
        <Group>
          <Note tone="danger" icon={<CircleAlert />}>
            keybindings.json could not be read: {state.error}. Fix it in a text editor; changes here
            are blocked until then.
          </Note>
        </Group>
      )}
      <p className="mb-6 px-1 text-sm leading-relaxed text-fg-3">
        These apply when you run the engine in a terminal; open terminal sessions pick them up after{' '}
        <KeyHint>/reload</KeyHint>. Vengeance’s own shortcuts are under Keyboard shortcuts.
      </p>
      <SearchQueryContext.Provider value={query}>
        {groups.length === 0 && (
          <Group>
            <Note icon={<Search />}>
              No action matches “<Highlight text={query} />
              ”.
            </Note>
          </Group>
        )}
        {groups.map(([group, actions]) => (
          <Group key={group} title={group}>
            {actions.map((action) => {
              const custom = action.id in state.bindings
              return (
                <ActionRow
                  key={action.id}
                  action={action}
                  keys={custom ? state.bindings[action.id]! : action.defaults}
                  custom={custom}
                  conflictsWith={conflicts.get(action.id) ?? []}
                  onChange={(keys) => void change(action.id, keys)}
                />
              )
            })}
          </Group>
        ))}
      </SearchQueryContext.Provider>
    </>
  )
}
