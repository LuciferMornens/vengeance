// QA fixture package extension: registers /qa-pkg-legacy (the one filters exclude).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('qa-pkg-legacy', {
    description: 'QA package: legacy command',
    handler: async (_args, ctx) => ctx.ui.notify('QA package legacy', 'info')
  })
}
