// QA runner: finds scripts/qa/**/*.qa.mjs and runs each suite in its own Node process, one after
// another, then prints a PASS/FAIL summary. Exit code 1 when any suite failed.
//
//   npm run qa                                     every suite (npm run build first)
//   npm run qa -- --only "settings/**"             suites whose path or file name matches a glob
//   npm run qa -- --only smoke.qa.mjs --only "chat/*"
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join, matchesGlob, relative, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const qaDir = dirname(fileURLToPath(import.meta.url))
const SUITE_SUFFIX = '.qa.mjs'

function onlyPatterns(argv) {
  const patterns = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--only') continue
    const pattern = argv[index + 1]
    if (!pattern) throw new Error('--only needs a glob, e.g. --only "settings/**"')
    patterns.push(pattern)
    index++
  }
  return patterns
}

function runSuiteFile(file) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' })
    child.on('exit', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)))
    child.on('error', () => resolveRun(1))
  })
}

const patterns = onlyPatterns(process.argv.slice(2))
const suites = (await readdir(qaDir, { recursive: true }))
  .filter((file) => file.endsWith(SUITE_SUFFIX))
  .map((file) => file.split(sep).join('/'))
  .filter(
    (file) =>
      patterns.length === 0 ||
      patterns.some((p) => matchesGlob(file, p) || matchesGlob(basename(file), p))
  )
  .sort()

if (suites.length === 0) {
  console.error(`No QA suites match ${patterns.length ? patterns.join(', ') : `*${SUITE_SUFFIX}`}`)
  process.exit(1)
}

const results = []
for (const suite of suites) {
  const started = performance.now()
  const code = await runSuiteFile(join(qaDir, suite))
  results.push({ suite, passed: code === 0, seconds: (performance.now() - started) / 1000 })
}

console.log(`\nQA summary (${relative(process.cwd(), qaDir) || '.'})`)
for (const { suite, passed, seconds } of results) {
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${suite}  (${seconds.toFixed(1)}s)`)
}
const failed = results.filter((result) => !result.passed).length
console.log(
  failed
    ? `${failed} of ${results.length} suite(s) failed`
    : `All ${results.length} suite(s) passed`
)
process.exit(failed ? 1 : 0)
