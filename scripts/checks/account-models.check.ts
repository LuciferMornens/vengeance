import { strict as assert } from 'node:assert'
import { offeredModelIds } from '../../src/main/features/settings/offered-models'
import { check } from './harness'

await check('offeredModelIds: the ChatGPT list keeps listed, API-callable slugs in order', () => {
  const body = {
    models: [
      { slug: 'gpt-6.1-sol', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-reserve', visibility: 'hide', supported_in_api: true },
      { slug: 'gpt-6-luna', visibility: 'list', supported_in_api: true },
      { slug: 'chat-only', visibility: 'list', supported_in_api: false },
      { slug: 'gpt-6-luna', visibility: 'list' },
      { display_name: 'no slug' }
    ]
  }
  assert.deepEqual(offeredModelIds(body), ['gpt-6.1-sol', 'gpt-6-luna'])
})

await check('offeredModelIds: the API list (data[].id); anything else is empty', () => {
  assert.deepEqual(
    offeredModelIds({
      object: 'list',
      data: [{ id: 'gpt-6-sol' }, { id: 'gpt-5.6-terra' }, { object: 'model' }]
    }),
    ['gpt-6-sol', 'gpt-5.6-terra']
  )
  assert.deepEqual(offeredModelIds({ error: { code: 'invalid_api_key' } }), [])
  assert.deepEqual(offeredModelIds(null), [])
  assert.deepEqual(offeredModelIds('models'), [])
  assert.deepEqual(offeredModelIds({ models: 'nope' }), [])
})
