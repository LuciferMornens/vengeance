// npm packages against a local fake registry (npm_config_registry): install from Settings →
// Packages, the update check in the Updates sheet once a newer version is published, the per-package
// Update, and the installed version afterwards. Never touches the real engine install: only the
// package's own Update button is used (never "Update all" or the engine row).
//
//   node scripts/qa/ext/packages-updates.qa.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stubMainNetwork } from '../lib/main-stubs.mjs'
import { runSuite } from '../lib/suite.mjs'
import { bugSteps, FIXTURES_DIR, reportShot, runPaletteAction, until } from './lib/ext-helpers.mjs'
import { packFixture, startFakeRegistry } from './lib/fake-registry.mjs'

const NAME = 'vengeance-qa-fixture-remote'
/** The engine's release check (main fetches it): PI_OFFLINE is lifted for npm, and a real newer engine would list. */
const ENGINE_RELEASE_URL = 'https://pi.dev/api/latest-version'
const work = mkdtempSync(join(tmpdir(), 'vengeance-qa-registry-'))
const registry = await startFakeRegistry()
registry.publish(
  NAME,
  '1.0.0',
  packFixture(join(FIXTURES_DIR, 'qa-pkg'), { name: NAME, version: '1.0.0' }, work)
)

try {
  await runSuite(
    'ext-packages-updates',
    async ({ agentDir, app, step }) => {
      const { page } = app
      const { bugStep, finish } = bugSteps(step)
      const installed = () =>
        JSON.parse(
          readFileSync(join(agentDir.dir, 'npm', 'node_modules', NAME, 'package.json'), 'utf8')
        ).version
      const sheet = page.getByRole('dialog', { name: 'Updates' })
      await stubMainNetwork(app, [{ prefix: ENGINE_RELEASE_URL, json: { version: '0.0.0' } }])

      await step(
        'install npm:<name> from the fake registry through Settings → Packages',
        async () => {
          await app.openWorkspace()
          await app.test('openSettings', 'packages')
          await page
            .getByPlaceholder('npm:@scope/pkg, git:github.com/user/repo, or a local path')
            .fill(`npm:${NAME}`)
          await page.getByRole('button', { name: 'Install', exact: true }).click()
          await page
            .getByText(/^(Done|Failed)/)
            .first()
            .waitFor({ timeout: 120_000 })
          await reportShot(app, 'ext-updates-npm-installed')
          assert.deepEqual((await agentDir.readJson('settings.json')).packages, [`npm:${NAME}`])
          assert.equal(installed(), '1.0.0')
          assert.ok(
            registry.requests.some((r) => r.path === `/${NAME}`),
            'npm asked the fake registry'
          )
          const row = page.locator(`[id="setting-package.${NAME}"]`)
          await row.getByText('1.0.0').waitFor()
          await row.getByText('Qa fixture remote', { exact: true }).waitFor()
        }
      )

      await step('publish 1.1.0; "Check now" lists the package update', async () => {
        registry.publish(
          NAME,
          '1.1.0',
          packFixture(join(FIXTURES_DIR, 'qa-pkg'), { name: NAME, version: '1.1.0' }, work)
        )
        registry.setLatest(NAME, '1.1.0')
        await app.test('closeSettings')
        await runPaletteAction(app, 'Check for updates')
        await sheet.waitFor()
        await sheet.getByText('Qa fixture remote', { exact: true }).waitFor({ timeout: 60_000 })
        await page.getByText('1 update', { exact: true }).waitFor()
        await reportShot(app, 'ext-updates-sheet')
      })

      await bugStep('the update row shows 1.0.0 → 1.1.0 from the configured registry', async () => {
        await sheet.getByText('1.1.0').first().waitFor({ timeout: 5000 })
      })

      await step('the package Update button updates it to 1.1.0', async () => {
        const row = sheet
          .locator('div', { hasText: 'Qa fixture remote' })
          .filter({ has: page.getByRole('button', { name: 'Update', exact: true }) })
          .last()
        await row.getByRole('button', { name: 'Update', exact: true }).click()
        // npm replaces the folder while it updates; a missing package.json just means "not yet".
        await until(
          () => {
            try {
              return installed() === '1.1.0'
            } catch {
              return false
            }
          },
          { timeoutMs: 120_000, label: 'installed 1.1.0' }
        )
        await sheet
          .getByText(/^Updated/)
          .first()
          .waitFor({ timeout: 60_000 })
        await reportShot(app, 'ext-updates-updated')
      })

      await step('after the update the check is clean and Packages shows 1.1.0', async () => {
        await sheet.getByRole('button', { name: 'Check now' }).click()
        await until(
          async () => (await sheet.getByText('Qa fixture remote', { exact: true }).count()) === 0,
          {
            timeoutMs: 60_000,
            label: 'no pending package update'
          }
        )
        await page.keyboard.press('Escape')
        await app.test('openSettings', 'packages')
        await page.locator(`[id="setting-package.${NAME}"]`).getByText('1.1.0').waitFor()
      })

      finish()
    },
    {
      launch: {
        env: {
          PI_OFFLINE: undefined,
          npm_config_registry: `${registry.url}/`,
          npm_config_cache: join(work, 'npm-cache'),
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_update_notifier: 'false'
        }
      }
    }
  )
} finally {
  await registry.close()
  rmSync(work, { recursive: true, force: true })
}
