const { join } = require('node:path')
const { Arch } = require('electron-builder')

exports.default = async (context) => {
  const { verifyEngines } = await import('./verify.mjs')
  // macOS keeps resources in <App>.app/Contents/Resources.
  await verifyEngines({
    directory: join(context.packager.getResourcesDir(context.appOutDir), 'engines'),
    platform: `${context.electronPlatformName}-${Arch[context.arch]}`
  })
}
