import { strict as assert } from 'node:assert'
import { isReadAllowed } from '../../src/main/ipc/files'
import { check } from './harness'

const win = process.platform === 'win32'
const access = {
  allowedRoots: [win ? 'D:\\proj' : '/proj', win ? 'C:\\Users\\u\\.pi\\agent\\sessions' : '/home/u/.pi/agent/sessions'],
  deniedFiles: [win ? 'C:\\Users\\u\\.pi\\agent\\auth.json' : '/home/u/.pi/agent/auth.json']
}

await check('isReadAllowed: files inside workspaces and session folders only', () => {
  assert.equal(isReadAllowed(win ? 'D:\\proj\\src\\a.ts' : '/proj/src/a.ts', access), true)
  assert.equal(isReadAllowed(win ? 'C:\\Users\\u\\.pi\\agent\\sessions\\--x--\\s.jsonl' : '/home/u/.pi/agent/sessions/--x--/s.jsonl', access), true)
  assert.equal(isReadAllowed(win ? 'D:\\project-other\\a.ts' : '/project-other/a.ts', access), false)
  assert.equal(isReadAllowed(win ? 'D:\\proj\\..\\secret.txt' : '/proj/../secret.txt', access), false)
  assert.equal(isReadAllowed(win ? 'C:\\Users\\u\\.pi\\agent\\settings.json' : '/home/u/.pi/agent/settings.json', access), false)
})

await check('isReadAllowed: credential files are refused even inside an allowed root', () => {
  const wide = { ...access, allowedRoots: [win ? 'C:\\Users\\u' : '/home/u'] }
  assert.equal(isReadAllowed(win ? 'C:\\Users\\u\\.pi\\agent\\auth.json' : '/home/u/.pi/agent/auth.json', wide), false)
  if (win) assert.equal(isReadAllowed('c:\\users\\U\\.PI\\agent\\AUTH.json', wide), false)
})
