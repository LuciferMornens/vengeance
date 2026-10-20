// QA MCP fixture server (no dependencies): newline-delimited JSON-RPC over stdio when run as a
// script, and `handleMcpMessage()` for the streamable-HTTP variant a suite hosts itself.
//
// Tools: qa_add {a, b} → "sum=<a+b>", qa_env → the QA_MCP_TOKEN it was started with, qa_fail →
// an isError result. Resources: qa://notes/hello (text). Every start is appended to the file in
// QA_MCP_LOG, or in a `--log=<file>` argument (Engine 2's kernel starts servers with a cleared
// environment), so a suite can count connections and reconnects. With `--hang` it never answers,
// not even the handshake.
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TOOLS = [
  {
    name: 'qa_add',
    description: 'Add two numbers (QA MCP fixture).',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'qa_env',
    description: 'Report the QA_MCP_TOKEN environment variable the server was started with.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'qa_fail',
    description: 'Always fails (QA MCP fixture).',
    inputSchema: { type: 'object', properties: {} }
  }
]

const RESOURCES = [
  { uri: 'qa://notes/hello', name: 'hello-note', description: 'A QA note', mimeType: 'text/plain' }
]

/**
 * Answer one JSON-RPC message. `context.env` is the environment to report, `context.headers` the
 * HTTP headers of the request (HTTP variant). Returns the response object, or null for
 * notifications.
 */
export function handleMcpMessage(message, context = {}) {
  const { id, method, params = {} } = message
  if (id === undefined) return null
  const result = (value) => ({ jsonrpc: '2.0', id, result: value })
  switch (method) {
    case 'initialize':
      return result({
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: {} },
        serverInfo: { name: 'qa-mcp-fixture', version: '1.0.0' },
        instructions: 'QA MCP fixture: arithmetic and environment checks.'
      })
    case 'ping':
      return result({})
    case 'tools/list':
      return result({ tools: TOOLS })
    case 'tools/call': {
      const args = params.arguments ?? {}
      if (params.name === 'qa_add') {
        return result({
          content: [{ type: 'text', text: `sum=${Number(args.a) + Number(args.b)}` }]
        })
      }
      if (params.name === 'qa_env') {
        const env = context.env ?? process.env
        const auth = context.headers?.authorization
        const text = `token=${env.QA_MCP_TOKEN ?? '(unset)'}${auth ? ` authorization=${auth}` : ''}`
        return result({ content: [{ type: 'text', text }] })
      }
      if (params.name === 'qa_fail') {
        return result({ content: [{ type: 'text', text: 'QA MCP failure' }], isError: true })
      }
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params.name}` } }
    }
    case 'resources/list':
      return result({ resources: RESOURCES })
    case 'resources/templates/list':
      return result({ resourceTemplates: [] })
    case 'resources/read':
      if (params.uri === 'qa://notes/hello') {
        return result({
          contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'QA-MCP-RESOURCE-TEXT' }]
        })
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32002, message: `Unknown resource ${params.uri}` }
      }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
}

const LOG_ARGUMENT = '--log='
const HANG_ARGUMENT = '--hang'

function runStdio() {
  const logArgument = process.argv.find((value) => value.startsWith(LOG_ARGUMENT))
  const startLog = logArgument ? logArgument.slice(LOG_ARGUMENT.length) : process.env.QA_MCP_LOG
  if (startLog) appendFileSync(startLog, `start ${process.pid}\n`)
  process.stdin.on('end', () => process.exit(0))
  if (process.argv.includes(HANG_ARGUMENT)) {
    process.stdin.resume()
    return
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const response = handleMcpMessage(JSON.parse(line))
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
    }
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runStdio()
