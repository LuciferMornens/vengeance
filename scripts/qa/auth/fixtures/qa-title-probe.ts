/**
 * QA fixture extension: picks a conversation-title model the way session auto-title packages do (the
 * first available model of the preferred providers, else the session's model) and asks it for a title.
 * `/qa-title <provider>/<id>` asks that model instead. Loaded from the temp agent dir
 * (`<agentDir>/extensions/qa-title-probe.ts`) by `refused-sign-in.qa.mjs`.
 *
 * Every attempt is appended as one JSON line to `<agentDir>/qa-title-log.jsonl`.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const LOG_FILE = join(process.env.PI_CODING_AGENT_DIR ?? '.', 'qa-title-log.jsonl')
/** A subscription sign-in first, as auto-title packages prefer one, then the local QA provider. */
const PREFERRED_PROVIDERS = ['kimi-coding', 'qa']

const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`

export default function qaTitleProbe(pi: ExtensionAPI) {
  pi.registerCommand('qa-title', {
    description: 'QA: pick a title model and ask it for a title',
    handler: async (args, ctx) => {
      const available = ctx.modelRegistry.getAvailable()
      const requested = args.trim()
      const [provider = '', ...id] = requested.split('/')
      const model = requested
        ? ctx.modelRegistry.find(provider, id.join('/'))
        : (PREFERRED_PROVIDERS.map((name) => available.find((m) => m.provider === name)).find(
            Boolean
          ) ?? ctx.model)
      const started = Date.now()
      let outcome: { ok: boolean; title?: string; error?: string }
      try {
        if (!model) throw new Error(`No model ${requested}`)
        const reply = await ctx.modelRegistry.complete(model, {
          messages: [{ role: 'user', content: 'Title this chat: hi', timestamp: Date.now() }]
        })
        const title = reply.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        outcome =
          reply.stopReason === 'error'
            ? { ok: false, error: reply.errorMessage }
            : { ok: true, title }
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      const entry = {
        available: available.map(key),
        model: model ? key(model) : null,
        ms: Date.now() - started,
        ...outcome
      }
      appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`)
    }
  })
}
