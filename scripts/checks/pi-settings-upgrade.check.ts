import { strict as assert } from 'node:assert'
import { validateSettings } from '../../src/main/features/settings/validate'
import { check } from './harness'

await check(
  'Engine sharing preferences accept native destinations in either settings scope',
  () => {
    for (const scope of ['global', 'project'] as const) {
      for (const destination of ['auto', 'gist', 'radius']) {
        assert.deepEqual(validateSettings({ sessionShareDestination: destination }, scope), [])
      }
    }
  }
)

await check(
  'Engine sharing preferences reject unsupported destinations before writing settings',
  () => {
    const issues = validateSettings({ sessionShareDestination: 'public' }, 'global')
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.severity, 'error')
    assert.equal(issues[0]?.key, 'sessionShareDestination')
  }
)
