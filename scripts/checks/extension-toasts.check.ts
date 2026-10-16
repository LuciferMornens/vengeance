import { strict as assert } from 'node:assert'
import { extensionErrorText, splitNotifyMessage } from '../../src/renderer/features/extension-ui/toast-text'
import { check } from './harness'

await check('splitNotifyMessage: first line is the title, the rest keeps its line breaks', () => {
  const message = 'MCP servers need attention:\n  qa-broken: failed\nRun /mcp to fix.'
  assert.deepEqual(splitNotifyMessage(message), { title: 'MCP servers need attention:', description: '  qa-broken: failed\nRun /mcp to fix.' })
  assert.deepEqual(splitNotifyMessage('\n\nSaved\n\n'), { title: 'Saved', description: undefined })
})

await check('extensionErrorText: a throwing command is named; other failures name the extension, first line only', () => {
  assert.deepEqual(extensionErrorText({ type: 'extension_error', extensionPath: 'command:qa-throw', event: 'command', error: 'QA fixture command exploded' }), {
    title: '/qa-throw failed',
    description: 'QA fixture command exploded'
  })
  const hook = extensionErrorText({ type: 'extension_error', extensionPath: 'C:\\x\\node_modules\\pi-lens-lsp\\dist\\index.js', event: 'tool_result', error: 'boom\n    at f (x.js:1)' })
  assert.deepEqual(hook, { title: 'Lens LSP ran into an error', description: 'boom' })
})
