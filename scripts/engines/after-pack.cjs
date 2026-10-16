const { join } = require('node:path')

exports.default = async (context) => {
  const { verifyEngines } = await import('./verify.mjs')
  await verifyEngines(join(context.appOutDir, 'resources', 'engines'))
}
