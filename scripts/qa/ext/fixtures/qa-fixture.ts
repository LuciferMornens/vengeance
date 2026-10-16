/**
 * QA fixture extension: exercises every ExtensionAPI / ctx.ui surface that matters to an RPC host.
 * Loaded from the temp agent dir (`<agentDir>/extensions/qa-fixture.ts`) by the ext QA suites.
 *
 * Every observable result is appended as one JSON line to `<agentDir>/qa-ext-log.jsonl`
 * (`{ kind, ...data }`), so a suite can prove that an answer reached the extension.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const LOG_FILE = join(process.env.PI_CODING_AGENT_DIR ?? '.', 'qa-ext-log.jsonl')

function log(kind: string, data: Record<string, unknown> = {}): void {
  appendFileSync(LOG_FILE, `${JSON.stringify({ kind, at: Date.now(), ...data })}\n`)
}

/** `/qa-x 1500` → { timeout: 1500 }; no number → no timeout. */
function dialogOptions(args: string): { timeout?: number } {
  const ms = Number.parseInt(args.trim(), 10)
  return Number.isFinite(ms) && ms > 0 ? { timeout: ms } : {}
}

export default function qaFixture(pi: ExtensionAPI) {
  // ─── flags and shortcuts ──────────────────────────────────────────────────────────────────
  pi.registerFlag('qa-mode', { description: 'QA fixture: run mode label for the fixture extension.', type: 'string', default: 'normal' })
  pi.registerFlag('qa-loud', { description: 'QA fixture: announce every turn with a notification.', type: 'boolean', default: false })
  pi.registerShortcut('ctrl+shift+q', {
    description: 'QA fixture shortcut',
    handler: () => log('shortcut')
  })

  // ─── lifecycle ────────────────────────────────────────────────────────────────────────────
  pi.on('session_start', (event, ctx) => {
    log('session_start', { reason: event.reason, mode: ctx.mode, hasUI: ctx.hasUI, flags: { mode: pi.getFlag('qa-mode'), loud: pi.getFlag('qa-loud') } })
  })
  pi.on('turn_end', (_event, ctx) => {
    log('turn_end')
    if (pi.getFlag('qa-loud') === true) ctx.ui.notify('QA loud turn finished', 'info')
  })
  pi.on('agent_end', () => log('agent_end'))
  pi.on('session_shutdown', () => log('session_shutdown'))

  // ─── input transform ──────────────────────────────────────────────────────────────────────
  pi.on('input', (event, ctx) => {
    log('input', { text: event.text, source: event.source })
    if (event.text.startsWith('qa-transform:')) {
      return { action: 'transform', text: `TRANSFORMED ${event.text.slice('qa-transform:'.length).trim()}` }
    }
    if (event.text === 'qa-handled') {
      ctx.ui.notify('QA handled the input itself', 'info')
      return { action: 'handled' }
    }
    return { action: 'continue' }
  })

  // ─── system prompt ────────────────────────────────────────────────────────────────────────
  pi.on('before_agent_start', (event) => {
    log('before_agent_start', { prompt: event.prompt })
    return { systemPrompt: `${event.systemPrompt}\n\nQA-SYSTEM-MARKER mode=${String(pi.getFlag('qa-mode'))}` }
  })

  // ─── tool interception ────────────────────────────────────────────────────────────────────
  pi.on('tool_call', async (event, ctx) => {
    log('tool_call', { toolName: event.toolName, input: event.input })
    if (event.toolName === 'bash' && String((event.input as { command?: unknown }).command ?? '').includes('QA_BLOCK_ME')) {
      return { block: true, reason: 'Blocked by the QA fixture' }
    }
    if (event.toolName === 'qa_guarded') {
      const allowed = await ctx.ui.confirm('QA allow the guarded tool?', 'The fixture asks before qa_guarded runs.', { signal: ctx.signal })
      log('guard_answer', { allowed })
      if (!allowed) return { block: true, reason: 'The user declined qa_guarded' }
    }
    return undefined
  })
  pi.on('tool_result', (event) => {
    if (event.toolName === 'qa_boom') throw new Error('QA fixture tool_result handler exploded')
    return undefined
  })

  // ─── tools ────────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: 'qa_echo',
    label: 'QA Echo',
    description: 'Echo the given text back (QA fixture).',
    promptSnippet: 'qa_echo: echo text back',
    parameters: Type.Object({ text: Type.String({ description: 'Text to echo' }) }),
    async execute(_id, params) {
      log('qa_echo', { text: params.text })
      return { content: [{ type: 'text', text: `QA-ECHO: ${params.text}` }], details: { echoed: params.text } }
    },
    renderCall: () => {
      throw new Error('renderCall is terminal-only; an RPC host never calls it')
    }
  })
  pi.registerTool({
    name: 'qa_guarded',
    label: 'QA Guarded',
    description: 'A tool the fixture guards with a confirm dialog.',
    parameters: Type.Object({}),
    async execute() {
      log('qa_guarded_ran')
      return { content: [{ type: 'text', text: 'QA-GUARDED-RAN' }], details: undefined }
    }
  })
  pi.registerTool({
    name: 'qa_boom',
    label: 'QA Boom',
    description: 'A tool whose tool_result handler throws.',
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: 'QA-BOOM-RESULT' }], details: undefined }
    }
  })
  pi.registerTool({
    name: 'qa_fail',
    label: 'QA Fail',
    description: 'A tool that throws from execute().',
    parameters: Type.Object({}),
    async execute() {
      throw new Error('QA fixture tool failure')
    }
  })
  pi.registerTool({
    name: 'qa_hidden',
    label: 'QA Hidden',
    description: 'Registered with hidden exposure: never declared.',
    exposure: 'hidden',
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: 'hidden' }], details: undefined }
    }
  })
  pi.registerTool({
    name: 'qa_scripted',
    label: 'QA Scripted',
    description: 'Codemode exposure inside the qa namespace.',
    exposure: 'codemode',
    namespace: { name: 'qa', description: 'QA fixture tools', instructions: 'Call qa tools from scripts.' },
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: 'scripted' }], details: undefined }
    }
  })

  // ─── dialogs ──────────────────────────────────────────────────────────────────────────────
  pi.registerCommand('qa-select', {
    description: 'QA: select dialog (arg: timeout ms)',
    handler: async (args, ctx) => {
      const value = await ctx.ui.select('QA pick a fruit', ['Apple', 'Banana', 'Cherry'], dialogOptions(args))
      log('select', { value: value ?? null })
    }
  })
  pi.registerCommand('qa-select-many', {
    description: 'QA: select dialog with a filterable list',
    handler: async (_args, ctx) => {
      const options = Array.from({ length: 12 }, (_, i) => `Option ${String(i + 1).padStart(2, '0')}`)
      const value = await ctx.ui.select('QA pick one of many', options)
      log('select_many', { value: value ?? null })
    }
  })
  pi.registerCommand('qa-later', {
    description: 'QA: a select dialog that opens later (arg: delay ms, default 2000)',
    handler: async (args, ctx) => {
      const delay = Number.parseInt(args.trim(), 10) || 2000
      setTimeout(() => {
        void ctx.ui.select('QA late question', ['Later yes', 'Later no']).then((value) => log('later', { value: value ?? null }))
      }, delay)
    }
  })
  pi.registerCommand('qa-signal', {
    description: 'QA: confirm bound to an AbortSignal that fires after 1.5 s (no timeout field)',
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm('QA signal-bound question', 'This dialog is withdrawn by its AbortSignal.', { signal: AbortSignal.timeout(1500) })
      log('signal', { confirmed })
    }
  })
  pi.registerCommand('qa-confirm', {
    description: 'QA: confirm dialog (arg: timeout ms)',
    handler: async (args, ctx) => {
      const confirmed = await ctx.ui.confirm('QA proceed?', 'The fixture wants a **yes** or no.', dialogOptions(args))
      log('confirm', { confirmed })
    }
  })
  pi.registerCommand('qa-input', {
    description: 'QA: input dialog (arg: timeout ms)',
    handler: async (args, ctx) => {
      const value = await ctx.ui.input('QA your codename', 'e.g. falcon', dialogOptions(args))
      log('input_dialog', { value: value ?? null })
    }
  })
  pi.registerCommand('qa-editor', {
    description: 'QA: multi-line editor dialog',
    handler: async (_args, ctx) => {
      const value = await ctx.ui.editor('QA edit the notes', 'first line\nsecond line')
      log('editor', { value: value ?? null })
    }
  })

  // ─── fire-and-forget UI ───────────────────────────────────────────────────────────────────
  pi.registerCommand('qa-notify', {
    description: 'QA: info, warning and error notifications',
    handler: async (_args, ctx) => {
      ctx.ui.notify('QA info notice', 'info')
      ctx.ui.notify('QA warning notice', 'warning')
      ctx.ui.notify('QA error notice', 'error')
      log('notify')
    }
  })
  pi.registerCommand('qa-status', {
    description: 'QA: set or clear the status entry (arg: clear)',
    handler: async (args, ctx) => {
      ctx.ui.setStatus('qa-fixture', args.trim() === 'clear' ? undefined : 'QA status ready')
      log('status', { cleared: args.trim() === 'clear' })
    }
  })
  pi.registerCommand('qa-widget', {
    description: 'QA: widgets above and below the editor (arg: clear)',
    handler: async (args, ctx) => {
      if (args.trim() === 'clear') {
        ctx.ui.setWidget('qa-above', undefined)
        ctx.ui.setWidget('qa-below', undefined, { placement: 'belowEditor' })
      } else {
        ctx.ui.setWidget('qa-above', ['QA widget above line 1', 'QA widget above line 2'])
        ctx.ui.setWidget('qa-below', ['QA widget below the editor'], { placement: 'belowEditor' })
        ctx.ui.setWidget('qa-component', () => {
          throw new Error('component widgets are terminal-only')
        })
      }
      log('widget', { cleared: args.trim() === 'clear' })
    }
  })
  pi.registerCommand('qa-title', {
    description: 'QA: set the session title',
    handler: async (args, ctx) => {
      ctx.ui.setTitle(args.trim() || 'QA Fixture Title')
      log('title', { title: args.trim() || 'QA Fixture Title' })
    }
  })
  pi.registerCommand('qa-prefill', {
    description: 'QA: put text into the composer',
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(args.trim() || 'QA prefilled text')
      log('prefill')
    }
  })
  pi.registerCommand('qa-paste', {
    description: 'QA: pasteToEditor (falls back to setEditorText)',
    handler: async (args, ctx) => {
      ctx.ui.pasteToEditor(args.trim() || 'QA pasted text')
      log('paste')
    }
  })
  pi.registerCommand('qa-terminal-only', {
    description: 'QA: terminal-only UI methods and what they return in RPC mode',
    handler: async (_args, ctx) => {
      const custom = await ctx.ui.custom(() => {
        throw new Error('custom() factories are terminal-only')
      })
      ctx.ui.setWorkingMessage('QA working message')
      ctx.ui.setFooter(undefined)
      ctx.ui.setHeader(undefined)
      log('terminal_only', {
        custom: custom === undefined ? 'undefined' : 'value',
        editorText: ctx.ui.getEditorText(),
        themes: ctx.ui.getAllThemes().length,
        setTheme: ctx.ui.setTheme('dark'),
        toolsExpanded: ctx.ui.getToolsExpanded()
      })
    }
  })
  pi.registerCommand('qa-message', {
    description: 'QA: post a custom message into the transcript',
    handler: async () => {
      pi.sendMessage({ customType: 'qa-note', content: 'QA custom message body', display: true, details: { from: 'fixture' } })
      log('message')
    }
  })
  pi.registerCommand('qa-complete', {
    description: 'QA: a command with argument completions',
    getArgumentCompletions: (prefix) =>
      ['alpha', 'beta', 'gamma'].filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item, description: `QA completion ${item}` })),
    handler: async (args) => log('complete', { args })
  })
  pi.registerCommand('qa-throw', {
    description: 'QA: a command handler that throws',
    handler: async () => {
      throw new Error('QA fixture command exploded')
    }
  })
}
