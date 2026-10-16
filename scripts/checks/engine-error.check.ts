import { strict as assert } from 'node:assert'
import { friendlyEngineError } from '../../src/renderer/features/shell/engine-error'
import { check } from './harness'

await check('friendlyEngineError: the reason line from an unexpected exit, with display paths', () => {
  const failedExtension = [
    'Engine exited unexpectedly (code 1): [noise] startup line 198',
    'Failed to load extension "C:\\Users\\Some One\\.pi\\agent\\extensions\\broken.ts": Unexpected token',
    '    at load (C:\\x\\loader.js:1:1)'
  ].join('\n')
  assert.equal(friendlyEngineError(failedExtension), 'Failed to load extension "extensions/broken.ts": Unexpected token')
  assert.equal(
    friendlyEngineError('Engine exited unexpectedly (code 1): Error: Cannot find module /home/me/.pi/agent/x/index.js'),
    'Error: Cannot find module x/index.js'
  )
})

await check('friendlyEngineError: a broken package extension (the engine names a bare drive root)', () => {
  const raw = [
    'Engine exited unexpectedly (code 1): Error: Failed to load extension "D:\\qa\\qa-broken-pkg\\extensions\\broken.ts": ' +
      'Failed to load extension: ParseError: D:\\: Missing semicolon.  ',
    ' D:/qa/qa-broken-pkg/extensions/broken.ts:2:6',
    'Hint: Start without extensions using "pi -ne".'
  ].join('\n')
  assert.equal(
    friendlyEngineError(raw),
    'Error: Failed to load extension "extensions/broken.ts": Failed to load extension: ParseError: Missing semicolon.'
  )
})

await check('friendlyEngineError: spawn errors keep their meaning, paths with spaces shorten whole', () => {
  assert.equal(
    friendlyEngineError('Could not start the engine: spawn C:\\Program Files\\nodejs\\node.exe ENOENT'),
    'Could not start the engine: spawn nodejs/node.exe ENOENT'
  )
  assert.equal(
    friendlyEngineError('No engine found at file:///D:/tools/engine/cli.js'),
    'No engine found at engine/cli.js'
  )
})

await check('friendlyEngineError: noise only or nothing falls back to a calm sentence', () => {
  const noise = 'Engine exited unexpectedly (code 1): [noise] turn line 48\n[noise] turn line 49'
  assert.equal(friendlyEngineError(noise), 'The engine process exited unexpectedly.')
  assert.equal(friendlyEngineError(undefined), 'The engine process exited unexpectedly.')
  assert.equal(friendlyEngineError('Engine did not answer "get_state" within 90s'), 'Engine did not answer "get_state" within 90s')
})
