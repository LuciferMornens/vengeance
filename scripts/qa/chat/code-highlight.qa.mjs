// Chat: fenced code in an answer gets syntax colors. Tokenizing runs in a worker loaded from the app bundle
// (file:// inside asar when packaged), and any failure there falls back to plain text silently, so this suite
// asserts the colors themselves: keywords, strings and comments in TypeScript, and a second language.
//
//   node scripts/qa/chat/code-highlight.qa.mjs
import assert from 'node:assert/strict'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { until } from './helpers.mjs'

const TYPESCRIPT_ANSWER = [
  'Here is the loader:',
  '',
  '```ts',
  '// Reads the store from disk.',
  'export async function loadStore(path: string): Promise<number> {',
  "  const text = await readFile(path, 'utf8')",
  '  return JSON.parse(text).count',
  '}',
  '```'
].join('\n')

const PYTHON_ANSWER = [
  'And in Python:',
  '',
  '```python',
  'def load_store(path):',
  '    with open(path) as handle:',
  '        return len(handle.read())',
  '```'
].join('\n')

const UNRECOGNIZED_LANGUAGES = ['constructor', 'toString', '__proto__', 'unknown-language']
const WORKER_RESPONSE_TIMEOUT_MS = 30_000
const WORKER_TEST_CODE = 'export const answer = 42'

/** Class lists of the colored runs inside the code block that contains `marker`, once it has some. */
async function coloredRuns(app, marker) {
  return until(
    () =>
      app.page.evaluate((text) => {
        const block = [...document.querySelectorAll('[data-transcript-scroll] pre')].find((pre) =>
          pre.textContent.includes(text)
        )
        const runs = block ? [...block.querySelectorAll('[class*="syn-"]')] : []
        return runs.length ? runs.map((run) => run.className) : null
      }, marker),
    { label: `colors in the block with "${marker}"` }
  )
}

await runSuite(
  'chat-code-highlight',
  async ({ server, app, step }) => {
    await step('open a workspace', () => app.openWorkspace())

    await step('a TypeScript block gets keyword, string and comment colors', async () => {
      server.queue(turn.text(TYPESCRIPT_ANSWER))
      await app.send('Show the loader')
      await app.waitForSettle()
      const classes = (await coloredRuns(app, 'loadStore')).join(' ')
      for (const kind of ['syn-keyword', 'syn-string', 'syn-comment']) {
        assert.ok(classes.includes(kind), `${kind} in the TypeScript block (got: ${classes})`)
      }
    })

    await step(
      'worker messages reject prototype names and keep valid grammars usable',
      async () => {
        const target = app.page
          .workers()
          .find((worker) => worker.url().includes('highlight-worker-'))
        assert.ok(target, 'the bundled highlighting worker is running')
        const responses = await app.page.evaluate(
          async ({ url, languages, code, timeoutMs }) => {
            const worker = new Worker(url, { type: 'module' })
            let nextId = 0
            const request = (language) =>
              new Promise((resolveResponse, rejectResponse) => {
                const id = ++nextId
                const cleanup = () => {
                  clearTimeout(timer)
                  worker.removeEventListener('message', receive)
                  worker.removeEventListener('error', failed)
                }
                const receive = (event) => {
                  if (event.data.id !== id) return
                  cleanup()
                  resolveResponse(event.data)
                }
                const failed = () => {
                  cleanup()
                  rejectResponse(new Error('Highlighting worker failed'))
                }
                const timer = setTimeout(() => {
                  cleanup()
                  rejectResponse(new Error('Highlighting worker response timed out'))
                }, timeoutMs)
                worker.addEventListener('message', receive)
                worker.addEventListener('error', failed)
                worker.postMessage({ id, code, language })
              })
            try {
              const results = []
              for (const language of [...languages, 'typescript'])
                results.push(await request(language))
              return results
            } finally {
              worker.terminate()
            }
          },
          {
            url: target.url(),
            languages: UNRECOGNIZED_LANGUAGES,
            code: WORKER_TEST_CODE,
            timeoutMs: WORKER_RESPONSE_TIMEOUT_MS
          }
        )
        for (const [index, language] of UNRECOGNIZED_LANGUAGES.entries()) {
          assert.equal(responses[index].lines, null, `${language} uses the plain-text fallback`)
        }
        const tokens = responses.at(-1).lines.flat()
        assert.equal(tokens.map((token) => token.content).join(''), WORKER_TEST_CODE)
        assert.ok(tokens.some((token) => token.className?.includes('syn-keyword')))
      }
    )

    await step('a Python block gets colors too', async () => {
      server.queue(turn.text(PYTHON_ANSWER))
      await app.send('And in Python?')
      await app.waitForSettle()
      const classes = (await coloredRuns(app, 'load_store')).join(' ')
      assert.ok(
        classes.includes('syn-keyword'),
        `syn-keyword in the Python block (got: ${classes})`
      )
    })
  },
  { launch: { exe: process.env.QA_PACKAGED_EXE } }
)
