import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPackageDir, VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function runtimeVersionProbe(engine: ExtensionAPI): void {
  if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
    throw new Error(`Extension compatibility requires the upstream release version; got ${VERSION}`)
  }
  const metadata = JSON.parse(readFileSync(join(getPackageDir(), 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (metadata.version !== VERSION) throw new Error('The SDK and package versions disagree')

  engine.on('session_start', (_event, context) => {
    context.ui.setStatus('qa-runtime-version', VERSION)
  })
  engine.registerCommand('qa-runtime-version', {
    description: 'Report the native extension compatibility version',
    handler: async (_args, context) => {
      context.ui.notify(VERSION, 'info')
    }
  })
}
