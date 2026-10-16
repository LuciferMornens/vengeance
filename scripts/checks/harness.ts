/** Minimal check harness for scripts/checks/*.check.ts (bundled and run by scripts/checks/run.mjs). */

const results: Array<{ name: string; error?: unknown }> = []

export async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run()
    results.push({ name })
    console.log(`  ✓ ${name}`)
  } catch (error) {
    results.push({ name, error })
    console.error(`  ✗ ${name}\n    ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  }
}

export function failures(): number {
  return results.filter((r) => r.error !== undefined).length
}
