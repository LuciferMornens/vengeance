import { randomUUID } from 'node:crypto'
import type { ExtensionUIDialogRequest, RpcExtensionUIRequest } from '@shared/engine-types'

const E = '\u001b['

/**
 * Requests for the hidden `/mock-ui <kind>` command (not listed in get_commands), which opens extension UI
 * outside of a run so dialogs and toasts can be screenshotted. Kinds: select, confirm, input, editor, notify,
 * widgets (one widget above and one below the editor), widgets-clear. `dialog` waits for an answer.
 */
export function mockUiRequests(kind: string): { events: RpcExtensionUIRequest[]; dialog: ExtensionUIDialogRequest | null } {
  const base = { type: 'extension_ui_request' as const, id: randomUUID() }
  if (kind === 'widgets' || kind === 'widgets-clear') {
    const clear = kind === 'widgets-clear'
    return {
      events: [
        {
          ...base,
          method: 'setWidget',
          widgetKey: 'pi-todos',
          widgetLines: clear ? undefined : [`${E}1mTodos${E}22m ${E}2m1/3${E}22m`, ` ${E}32m●${E}39m Reproduce the dropped session write`, ` ${E}33m◐${E}39m Fix debounce in SessionStore.persist`, ` ${E}2m○ Add a regression test${E}22m`],
          widgetPlacement: 'aboveEditor'
        },
        {
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'setWidget',
          widgetKey: 'pi-lens',
          widgetLines: clear ? undefined : [`${E}2mlens${E}22m ${E}32m✓ 0 errors${E}39m  ${E}33m▲ 2 warnings${E}39m  ${E}2m· src/session/store.ts:48 unused import${E}22m`],
          widgetPlacement: 'belowEditor'
        }
      ],
      dialog: null
    }
  }
  if (kind === 'notify') {
    return {
      events: [
        { ...base, method: 'notify', message: 'Indexed 1,284 files for code search', notifyType: 'info' },
        { type: 'extension_ui_request', id: randomUUID(), method: 'notify', message: 'Rate limit at 80% — slowing down requests', notifyType: 'warning' },
        { type: 'extension_ui_request', id: randomUUID(), method: 'notify', message: 'MCP server "linear" disconnected', notifyType: 'error' }
      ],
      dialog: null
    }
  }
  const dialog: ExtensionUIDialogRequest | null =
    kind === 'select'
      ? {
          ...base,
          method: 'select',
          title: 'Which branch should the fix land on?',
          options: ['main', 'release/2.4', 'release/2.3', 'feature/session-sync', 'feature/titles-debounce', 'hotfix/rename-race', 'Create a new branch…'],
          timeout: 60_000
        }
      : kind === 'confirm'
        ? { ...base, method: 'confirm', title: 'Run database migration?', message: 'This applies 3 pending migrations to the local development database. The change can be rolled back with `npm run db:rollback`.', timeout: 30_000 }
        : kind === 'input'
          ? { ...base, method: 'input', title: 'Name the new branch', placeholder: 'e.g. fix/session-title-race' }
          : kind === 'editor'
            ? { ...base, method: 'editor', title: 'Edit commit message', prefill: 'fix(session): flush every pending title update\n\nThe debounced persist() call coalesced updates across sessions, so the\nlast rename inside the 250 ms window won and earlier ones were dropped.\n\nKeep one pending timer per session id instead.\n' }
            : null
  return { events: [], dialog }
}
