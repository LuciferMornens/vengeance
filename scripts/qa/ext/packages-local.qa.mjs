// Packages from local sources in the temp agent dir: install from a folder (global and project),
// the process log, friendly names, per-resource toggles inside a package, disable/enable, the
// packages.md object-entry filters, uninstall, and a local tarball. Every change is checked in
// settings.json and in the commands of a restarted engine.
//
//   node scripts/qa/ext/packages-local.qa.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runSuite } from '../lib/suite.mjs'
import { bugSteps, FIXTURES_DIR, reportShot, until } from './lib/ext-helpers.mjs'

const PKG_COMMANDS = [
  'qa-pkg-hello',
  'qa-pkg-legacy',
  'skill:qa-pkg-skill',
  'qa-pkg-review',
  'qa-pkg-other'
]

await runSuite(
  'ext-packages-local',
  async ({ agentDir, app, step }) => {
    const { page } = app
    const { bugStep, finish } = bugSteps(step)
    const pkgDir = join(dirname(agentDir.dir), 'local', 'pi-qa-tools')
    cpSync(join(FIXTURES_DIR, 'qa-pkg'), pkgDir, { recursive: true })
    let cwd

    const settings = () => agentDir.readJson('settings.json')
    const projectSettings = () =>
      JSON.parse(readFileSync(join(cwd, '.pi', 'settings.json'), 'utf8'))
    const sameDir = (source, base) => resolve(base, source) === resolve(pkgDir)
    const commandNames = async () => (await app.agentState()).commands.map((c) => c.name)
    const pkgCommands = async () =>
      (await commandNames()).filter((n) => PKG_COMMANDS.includes(n)).sort()
    const installInput = () =>
      page.getByPlaceholder('npm:@scope/pkg, git:github.com/user/repo, or a local path')

    /** Settings → Packages: install `source`, wait for the run card to finish. */
    const install = async (source, scope = 'Global') => {
      await installInput().fill(source)
      if (scope === 'Project') await page.getByRole('radio', { name: 'Project' }).click()
      else if (await page.getByRole('radio', { name: 'Global' }).count())
        await page.getByRole('radio', { name: 'Global' }).click()
      await page.getByRole('button', { name: 'Install', exact: true }).click()
      await page
        .getByText(/^(Done|Failed)/)
        .first()
        .waitFor({ timeout: 90_000 })
    }
    /** Click the "Restart engines" action of the restart toast and wait for the new commands. */
    const restartEngines = async (expect) => {
      await page
        .locator('[data-toaster]')
        .getByRole('button', { name: 'Restart engines' })
        .first()
        .click()
      return until(
        async () => {
          const names = await pkgCommands()
          return JSON.stringify(names) === JSON.stringify([...expect].sort()) ? names : null
        },
        {
          timeoutMs: 60_000,
          label: `engine commands ${expect.join(', ') || '(none)'}; now ${JSON.stringify(await pkgCommands())}`
        }
      )
    }
    const packageRow = (name) => page.locator('[id^="setting-package."]', { hasText: name })

    await step('open a plain workspace and Settings → Packages (empty)', async () => {
      ;({ cwd } = await app.openWorkspace())
      await app.test('openSettings', 'packages')
      await page
        .getByText('No packages yet. Install one above from npm, git or a local folder.')
        .waitFor()
    })

    await step(
      'install from a local folder: process log, settings.json, friendly row',
      async () => {
        await install(pkgDir)
        await reportShot(app, 'ext-packages-installed')
        await page.getByText(/^Done/).first().waitFor()
        const { packages } = await settings()
        assert.equal(packages.length, 1)
        assert.ok(
          sameDir(packages[0], agentDir.dir),
          `settings source ${packages[0]} resolves to the folder`
        )
        const row = packageRow('Qa tools')
        await row.waitFor()
        await row.getByText('1.2.3').waitFor()
        await row
          .getByText('QA fixture package: two extensions, a skill and two prompt templates.')
          .waitFor()
        await row.getByText('2 extensions · 1 skill · 2 prompts').waitFor()
        const text = await page.locator('main, [role="dialog"], body').first().innerText()
        assert.doesNotMatch(text, /\x1b\[|\[3\dm/, 'no raw ANSI escape codes in the UI')
      }
    )

    await step('process log details show the engine output', async () => {
      await page.getByRole('button', { name: 'Details' }).first().click()
      await page
        .getByText(/Installed .*pi-qa-tools/)
        .first()
        .waitFor()
      await reportShot(app, 'ext-packages-process-log')
    })

    await step('"Restart engines" loads every package resource', async () => {
      await restartEngines(PKG_COMMANDS)
    })

    await step(
      'Resources: a package resource toggle writes a filter into the package entry',
      async () => {
        await app.test('openSettings', 'resources')
        await page.getByRole('switch', { name: 'Enable legacy.ts' }).click()
        const entry = await until(
          async () => (await settings()).packages.find((p) => typeof p === 'object'),
          { label: 'object package entry' }
        )
        assert.ok(sameDir(entry.source, agentDir.dir))
        assert.equal(entry.extensions.length, 1)
        await reportShot(app, 'ext-packages-resource-filter')
      }
    )

    await step('the filter names legacy.ts relative to the package root', async () => {
      const entry = (await settings()).packages.find((p) => typeof p === 'object')
      // path.relative() on Windows writes a backslash (extensions<backslash>legacy.ts); the engine accepts it.
      const BACKSLASH = String.fromCharCode(92)
      assert.equal(entry.extensions[0].replaceAll(BACKSLASH, '/'), '-extensions/legacy.ts')
    })

    await step('restart: /qa-pkg-legacy is gone, the rest stays', async () => {
      await restartEngines(PKG_COMMANDS.filter((n) => n !== 'qa-pkg-legacy'))
    })

    await step(
      'disable the whole package: every type filtered to [], badge, no commands',
      async () => {
        await app.test('openSettings', 'packages')
        await page.getByRole('switch', { name: 'Enable Qa tools' }).click()
        const entry = await until(
          async () => {
            const found = (await settings()).packages.find((p) => typeof p === 'object')
            return found && Array.isArray(found.skills) && found.skills.length === 0 ? found : null
          },
          { label: 'disabled entry' }
        )
        for (const type of ['extensions', 'skills', 'prompts', 'themes'])
          assert.deepEqual(entry[type], [])
        await packageRow('Qa tools').getByText('Disabled').waitFor()
        await restartEngines([])
      }
    )

    await bugStep('enabling the package again keeps the earlier per-resource filter', async () => {
      await page.getByRole('switch', { name: 'Enable Qa tools' }).click()
      await until(
        async () => {
          const found = (await settings()).packages[0]
          return (
            typeof found === 'string' || !Array.isArray(found.skills) || found.skills.length !== 0
          )
        },
        { label: 'enabled entry' }
      )
      const entry = (await settings()).packages[0]
      assert.equal(typeof entry, 'object', `entry became ${JSON.stringify(entry)}`)
      assert.ok(
        entry.extensions?.some((p) => /legacy\.ts$/.test(p)),
        JSON.stringify(entry)
      )
    })

    await step(
      'packages.md object entry with globs, [] and exact paths filters the package',
      async () => {
        const current = await settings()
        await agentDir.writeText('settings.json', {
          ...current,
          packages: [
            {
              source: pkgDir,
              extensions: ['extensions/*.ts', '!extensions/legacy.ts'],
              skills: [],
              prompts: ['prompts/qa-pkg-review.md']
            }
          ]
        })
        await page
          .locator('[data-toaster]')
          .getByText('Restart to apply')
          .first()
          .waitFor({ timeout: 15_000 })
        await restartEngines(['qa-pkg-hello', 'qa-pkg-review'])
        const row = packageRow('Qa tools')
        await row.getByText('Filtered').waitFor()
        await row.getByText('1 extension · 1 prompt').waitFor()
        await reportShot(app, 'ext-packages-filtered')
      }
    )

    await step(
      'Resources reflects the filters (legacy, skill and the other prompt off)',
      async () => {
        await app.test('openSettings', 'resources')
        assert.equal(
          await page.getByRole('switch', { name: 'Enable hello.ts' }).getAttribute('aria-checked'),
          'true'
        )
        assert.equal(
          await page.getByRole('switch', { name: 'Enable legacy.ts' }).getAttribute('aria-checked'),
          'false'
        )
        assert.equal(
          await page
            .getByRole('switch', { name: 'Enable qa-pkg-skill' })
            .getAttribute('aria-checked'),
          'false'
        )
        assert.equal(
          await page
            .getByRole('switch', { name: /^Enable qa-pkg-other/ })
            .getAttribute('aria-checked'),
          'false'
        )
      }
    )

    await step('uninstall (global) removes the entry and the commands', async () => {
      await app.test('openSettings', 'packages')
      await packageRow('Qa tools').getByRole('button', { name: 'Package actions' }).click()
      await page.getByRole('menuitem', { name: 'Uninstall' }).click()
      await until(async () => ((await settings()).packages ?? []).length === 0, {
        timeoutMs: 60_000,
        label: 'package removed'
      })
      await page
        .getByText('No packages yet. Install one above from npm, git or a local folder.')
        .waitFor()
      assert.ok(existsSync(pkgDir), 'a local package folder is not deleted')
      await restartEngines([])
    })

    await step('install into the project scope writes .pi/settings.json', async () => {
      await app.test('openSettings', 'packages')
      await install(pkgDir, 'Project')
      const { packages } = projectSettings()
      assert.equal(packages.length, 1)
      assert.ok(sameDir(packages[0], join(cwd, '.pi')), `project source ${packages[0]}`)
      assert.ok(!(await settings()).packages?.length, 'global settings untouched')
      await reportShot(app, 'ext-packages-project')
    })

    await bugStep('the project package is listed under "This project"', async () => {
      await page.getByText('This project', { exact: true }).waitFor({ timeout: 5000 })
      await packageRow('Qa tools').waitFor({ timeout: 5000 })
      await packageRow('Qa tools').getByText('Not loaded · folder not trusted').waitFor()
    })

    await step('trusting the folder lists the project package', async () => {
      await page.getByRole('button', { name: 'Trust this folder' }).first().click()
      // The trust dialog loads on first use: give it a moment to open before deciding it did not.
      const choice = page.getByRole('option', { name: /Trust and remember/ })
      await choice.waitFor({ timeout: 5000 }).catch(() => undefined)
      if (await choice.count()) await choice.click()
      await page.getByText(/^Project trust for/).waitFor({ state: 'detached', timeout: 5000 })
      await packageRow('Qa tools').waitFor({ timeout: 15_000 })
      await packageRow('Qa tools')
        .getByText('Not loaded · folder not trusted')
        .waitFor({ state: 'detached', timeout: 15_000 })
    })

    await bugStep('uninstall removes the project package from .pi/settings.json', async () => {
      const row = packageRow('Qa tools')
      await row.getByRole('button', { name: 'Package actions' }).click()
      await page.getByRole('menuitem', { name: 'Uninstall' }).click()
      await until(async () => (projectSettings().packages ?? []).length === 0, {
        timeoutMs: 20_000,
        label: 'project package removed from .pi/settings.json'
      }).catch(async (error) => {
        await reportShot(app, 'ext-packages-project-uninstall-failed')
        throw error
      })
    })

    // The Engine has no tarball source, so the install box refuses a .tgz path with a reason as it
    // is typed (Install stays disabled) instead of starting a run.
    await step('a local tarball is refused with a reason', async () => {
      const tarball = execFileSync(
        'npm',
        ['pack', '--silent', '--pack-destination', dirname(pkgDir)],
        {
          cwd: pkgDir,
          shell: true,
          encoding: 'utf8'
        }
      )
        .trim()
        .split(/\r?\n/)
        .pop()
      const tgz = join(dirname(pkgDir), tarball)
      await app.test('openSettings', 'packages')
      await installInput().fill(tgz)
      await page.getByText(/tarball/i).first().waitFor({ timeout: 2000 })
      await reportShot(app, 'ext-packages-tarball')
      assert.ok(
        await page.getByRole('button', { name: 'Install', exact: true }).isDisabled(),
        'Install is disabled for a tarball'
      )
      await installInput().press('Enter')
      const listed = ((await settings()).packages ?? []).some((p) =>
        /\.tgz$/.test(typeof p === 'string' ? p : p.source)
      )
      assert.equal(listed, false, 'the tarball is not written to settings.json')
    })

    finish()
  },
  { launch: { allowErrors: [/Failed to load extension|Unknown file extension/] } }
)
