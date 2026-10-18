const { Arch } = require('electron-builder')

// Staging holds one host-built payload; refuse to pack it for another platform or architecture.
module.exports = async function (context) {
  const { verifyEngines } = await import('./verify.mjs')
  await verifyEngines({ platform: `${context.electronPlatformName}-${Arch[context.arch]}` })
}
