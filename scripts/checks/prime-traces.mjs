import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tempRoot = await mkdtemp(join(tmpdir(), 'vengeance-prime-traces-'))
const previousMock = process.env.VENGEANCE_MOCK
const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
process.env.VENGEANCE_MOCK = '0'
process.env.PRIME_AGENT_CODING_AGENT_DIR = join(tempRoot, 'agent')

try {
  const stub = {
    name: 'native-trace-stub',
    setup(bundler) {
      bundler.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      bundler.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({
        contents: `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(tempRoot)} }`,
        loader: 'js'
      }))
      bundler.onResolve({ filter: /^node:child_process$/ }, () => ({
        path: 'child_process',
        namespace: 'stub'
      }))
      bundler.onLoad({ filter: /^child_process$/, namespace: 'stub' }, () => ({
        contents: `
          import { EventEmitter } from 'node:events'
          globalThis.__traceFixture = { requests: [] }
          export function execFile() { throw new Error('Unexpected engine lookup') }
          export function spawn(executable, args, options) {
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stdin = new EventEmitter()
            child.kill = () => child.emit('close', 1)
            child.stdin.end = (text) => {
              const request = JSON.parse(text)
              globalThis.__traceFixture.requests.push({ executable, args, options, request })
              setImmediate(() => {
                child.stdout.emit('data', Buffer.from(JSON.stringify({
                  ok: true,
                  result: {
                    status: 'ready',
                    preview: {
                      sessionFile: request.sessionFile,
                      sessionId: 'fixture-session',
                      traceId: 'fixture-trace',
                      size: 321,
                      maxBytes: 999,
                      uploadable: true,
                      endpoint: 'https://user:secret@trace.example/path?token=SECRET#fragment',
                      gitRepo: 'https://user:secret@git.example/repo?token=SECRET',
                      contentPreview: JSON.stringify({
                        type: 'message',
                        message: {
                          role: 'assistant',
                          content: [
                            { type: 'text', text: 'Ordinary trace message stays visible.' },
                            { type: 'toolCall', args: JSON.stringify({
                              command: 'safe-command',
                              headers: { authorization: 'Bearer nested-secret' }
                            }) }
                          ]
                        },
                        headers: { authorization: 'Bearer header-secret' },
                        api_key: 'field-secret',
                        accessToken: 'access-secret',
                        env: { API_KEY: 'environment-secret' },
                        auth_config: { credentials: { type: 'oauth', access: 'oauth-secret' } },
                        note: 'Authorization: Bearer string-secret'
                      }),
                      truncated: false
                    }
                  }
                }) + '\\n'))
                child.emit('close', 0)
              })
            }
            return child
          }
        `,
        loader: 'js'
      }))
    }
  }

  const bundlePath = join(tempRoot, 'traces.mjs')
  await build({
    entryPoints: [join(root, 'src', 'main', 'engine', 'prime', 'traces.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(root, 'src', 'shared') },
    plugins: [stub],
    logLevel: 'silent'
  })
  const { runPrimeTraces } = await import(pathToFileURL(bundlePath).href)
  const cwd = join(tempRoot, 'workspace')
  const sessionFile = join(tempRoot, 'session.jsonl')
  const result = await runPrimeTraces({ cwd, action: 'preview' }, sessionFile)
  const invocation = globalThis.__traceFixture.requests.at(-1)

  assert.equal(result.status, 'ready')
  assert.equal(result.preview.sessionId, 'fixture-session')
  assert.equal(result.preview.endpoint, 'https://trace.example/path')
  assert.equal(result.preview.gitRepo, 'https://git.example/repo')
  assert.deepEqual(JSON.parse(result.preview.contentPreview), {
    type: 'message',
    role: 'assistant',
    contentBlocks: ['text', 'toolCall'],
    content: '[hidden in preview]'
  })
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  assert.ok(!JSON.stringify(result).includes('user:secret'))
  assert.deepEqual(invocation.args, ['--traces'])
  assert.equal(invocation.options.windowsHide, true)
  assert.equal(invocation.request.sessionFile, sessionFile)
  assert.equal(invocation.request.agentDir, process.env.PRIME_AGENT_CODING_AGENT_DIR)
  console.log('Prime trace preview strips credentials and message bodies from public result')

  const revealed = await runPrimeTraces({ cwd, action: 'preview-content' }, sessionFile)
  const content = revealed.preview.contentPreview
  assert.equal(revealed.status, 'ready')
  assert.equal(revealed.preview.endpoint, 'https://trace.example/path')
  assert.ok(content.includes('Ordinary trace message stays visible.'))
  assert.ok(content.includes('safe-command'))
  assert.ok(content.includes('[redacted]'))
  for (const secret of [
    'nested-secret',
    'header-secret',
    'field-secret',
    'access-secret',
    'environment-secret',
    'oauth-secret',
    'string-secret'
  ]) {
    assert.ok(!content.includes(secret), `${secret} leaked in revealed preview`)
  }
  assert.equal(globalThis.__traceFixture.requests.at(-1).request.action, 'preview-content')
  console.log('Prime trace content reveal keeps ordinary text and redacts credential contexts')
} finally {
  if (previousMock === undefined) delete process.env.VENGEANCE_MOCK
  else process.env.VENGEANCE_MOCK = previousMock
  if (previousAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR
  else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir
  const resolvedTempRoot = await realpath(tempRoot)
  const resolvedSystemTemp = await realpath(tmpdir())
  assert.ok(relative(resolvedSystemTemp, resolvedTempRoot).split(sep)[0] !== '..')
  await rm(resolvedTempRoot, { recursive: true, force: true })
}
