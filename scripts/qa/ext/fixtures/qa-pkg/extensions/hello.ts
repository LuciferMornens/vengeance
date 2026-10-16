// QA fixture package extension: registers /qa-pkg-hello.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('qa-pkg-hello', {
    description: 'QA package: hello command',
    handler: async (_args, ctx) => ctx.ui.notify('QA package says hello', 'info')
  })
}
