// Soft steps: a failing step (typically a known `// BUG <id>` step) is recorded and the suite goes
// on with the next independent step; `finish()` then fails the suite once, listing every failure.

/**
 * @param {(label: string, action: () => Promise<unknown>) => Promise<unknown>} step runSuite's step
 * @param {object} [options]
 * @param {import('./app.mjs').QaApp | (() => import('./app.mjs').QaApp | null)} [options.app]
 *   app (or a getter, for suites that relaunch) to screenshot `<name>-FAIL-<label>.png` on failure
 * @param {string} [options.name] screenshot prefix (default 'step')
 */
export function softSteps(step, { app, name = 'step' } = {}) {
  const failures = []
  const currentApp = () => (typeof app === 'function' ? app() : app)

  async function check(label, action) {
    try {
      return await step(label, action)
    } catch (error) {
      failures.push(`${label}: ${String(error.message).split('\n')[0]}`)
      console.error(`    ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`)
      const qaApp = currentApp()
      if (qaApp) {
        const shotName = `${name}-FAIL-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`
        await qaApp.screenshot(shotName, { settleMs: 0 }).catch(() => undefined)
        // Leave no dialog or menu open for the next step.
        await qaApp.page.keyboard.press('Escape').catch(() => undefined)
      }
      return undefined
    }
  }

  function finish() {
    if (failures.length) {
      throw new Error(`${failures.length} step(s) failed:\n  ${failures.join('\n  ')}`)
    }
  }

  return { check, finish, failures }
}
