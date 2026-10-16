import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '../../ui'
import { useSessions } from './store'

const SEARCH_FOCUS_DELAY_MS = 60

export function SidebarSearch() {
  const query = useSessions((state) => state.query)
  const setQuery = useSessions((state) => state.setQuery)
  const nonce = useSessions((state) => state.searchFocusNonce)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (nonce > 0) {
      const timer = setTimeout(() => input.current?.focus(), SEARCH_FOCUS_DELAY_MS)
      return () => clearTimeout(timer)
    }
  }, [nonce])
  return (
    <Input
      ref={input}
      inputSize="sm"
      value={query}
      placeholder="Search sessions"
      aria-label="Search sessions"
      leading={<Search />}
      trailing={
        query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery('')}
            className="rounded-xs p-0.5 text-fg-3 hover:bg-active hover:text-fg"
          >
            <X className="size-3" />
          </button>
        ) : undefined
      }
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && query) {
          event.stopPropagation()
          setQuery('')
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          document.querySelector<HTMLElement>('[data-session-list] [data-session-row]')?.focus()
        }
      }}
      className="bg-transparent [&_input]:bg-[color-mix(in_oklab,var(--surface-2)_60%,transparent)] [&_input]:shadow-[inset_0_0_0_1px_var(--hairline)]"
    />
  )
}

export function onSessionListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-session-row]')]
  const index = rows.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  event.preventDefault()
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next) next.focus()
  else if (event.key === 'ArrowUp')
    document.querySelector<HTMLInputElement>('input[aria-label="Search sessions"]')?.focus()
}
