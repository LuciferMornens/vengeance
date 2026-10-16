module.exports = async function () {
  const { verifyEngines } = await import('./verify.mjs')
  await verifyEngines()
}
