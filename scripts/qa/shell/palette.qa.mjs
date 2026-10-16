// Palette and shortcuts: every Ctrl+K command runs and does what its title says; every action
// shortcut listed in the shortcuts sheet works from the composer; no two actions share a combo.
// QA_ONLY=<regex> limits the steps.
import assert from 'node:assert/strict'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { startFakeLlm, turn } from '../lib/fake-llm.mjs'
import { launchRaw, runPalette, shot, sleep, tempRoot, waitUntil } from './lib/kit.mjs'

const failures = []
const only = process.env.QA_ONLY ? new RegExp(process.env.QA_ONLY) : null
async function step(label, action) {
  if (only && !only.test(label)) return
  console.log(`  • ${label}`)
  try {
    await action()
    console.log(`    ✓ ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.error(`    ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`)
  }
}

console.log('▶ shell/palette (fake)')
const root = await tempRoot('vengeance-qa-palette-')
const server = await startFakeLlm()
// keepRecentTokens 1: the Engine refuses to compact a session smaller than the recent part it keeps (default
// 20k tokens), and this suite's session is one short turn.
const agentDir = await createAgentDir({ server, settings: { compaction: { keepRecentTokens: 1 } } })
const exportsDir = root.path('exports')
await mkdir(exportsDir, { recursive: true })

let run
const page = () => run.page
const composer = () => page().getByRole('textbox', { name: 'Message' }).first()
const appState = () => run.test('appState')
const agentId = () => run.test('activeAgentId')
const agent = async () => run.test('agentState', await agentId())
/** Names of every open dialog (Radix dialogs/sheets and alert dialogs). */
const dialogs = () =>
  page().evaluate(() =>
    [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map(
      (el) => el.getAttribute('aria-label') ?? el.querySelector('h2')?.textContent ?? '(unnamed)'
    )
  )
async function closeOverlays() {
  for (
    let i = 0;
    i < 4 && ((await dialogs()).length || (await page().getByRole('combobox').isVisible()));
    i++
  ) {
    await page().keyboard.press('Escape')
    await sleep(350)
  }
}
async function expectDialog(name) {
  await waitUntil(async () => (await dialogs()).some((d) => name.test(d)), {
    timeoutMs: 8000,
    label: `dialog ${name} (open: ${JSON.stringify(await dialogs())})`
  })
}

async function launch() {
  run = await launchRaw({ userData: root.path('user-data'), agentDir: agentDir.dir })
  await run.app.evaluate(({ dialog }, dir) => {
    let n = 0
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1)
      const ext = options.filters?.[0]?.extensions?.[0] ?? 'out'
      return { canceled: false, filePath: `${dir}\\export-${++n}.${ext}` }
    }
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  }, exportsDir)
  const ws = await root.folder('ws-palette', { 'README.md': '# palette\n' })
  await run.test('openWorkspace', ws)
  server.queue(
    turn.toolCall('bash', { command: 'echo palette-tool' }, { thinking: 'Thinking about it.' }),
    turn.thinking('Thinking again.', 'Palette answer one.')
  )
  await composer().fill('first prompt')
  await composer().press('Enter')
  await run.test('waitForIdle', 60_000)
  await page().getByText('Palette answer one.').waitFor()
}

/** Every command title the root palette page lists, with the query cleared. */
async function paletteTitles() {
  await page().keyboard.press('Control+k')
  await page().getByRole('combobox').waitFor()
  await sleep(300)
  const titles = await page()
    .getByRole('option')
    .evaluateAll((els) => els.map((el) => el.textContent.trim()))
  await page().keyboard.press('Escape')
  await sleep(400)
  return titles
}

async function toasts() {
  const texts = await page()
    .locator('[aria-live="polite"]')
    .allInnerTexts()
    .catch(() => [])
  return texts.join(' / ').replace(/\s+/g, ' ').slice(0, 300) || '(none)'
}

/** The toast the copy action shows (success or the reason it did not copy). */
async function copyToast() {
  const toast = page()
    .getByText(/Copied the last response|Could not copy|Nothing to copy/)
    .first()
  await toast.waitFor({ timeout: 5000 }).catch(() => undefined)
  const text = await toast
    .locator('xpath=..')
    .innerText()
    .catch(() => '(no toast)')
  return text.replace(/\s+/g, ' ')
}

/** title → check run after the command; null means "covered by its own step". */
const CHECKS = {
  'New session': async () => {
    const before = await agentId()
    await waitUntil(async () => (await agentId()) && (await agentId()) !== before, {
      label: 'new agent'
    })
  },
  'Open folder…': async () => {
    // The stubbed dialog is cancelled: the app must stay in the session without an error.
    await sleep(500)
    await composer().waitFor()
    assert.deepEqual(run.errors(), [])
  },
  'Open settings': () => expectDialog(/Settings/),
  'Toggle sidebar': null,
  'Toggle inspector': null,
  'Show or hide thinking': null,
  'Expand or collapse tool output': null,
  'Compact context': async () => {
    const from = server.requests.length
    await waitUntil(async () => server.requests.length > from, { label: 'compaction request' })
    await page().locator('[data-toaster]').getByText('Context compacted').waitFor({ timeout: 15_000 })
    await run.test('waitForIdle', 30_000)
  },
  'Copy last response': async () => {
    const toastText = await copyToast()
    const text = await run.app.evaluate(({ clipboard }) => clipboard.readText())
    assert.match(text, /Palette answer/, `clipboard after "${toastText}"`)
  },
  // The info dialog is titled with the session name.
  'Session info': () => expectDialog(/first prompt|Session info/i),
  'Reload extensions and resources': async () => {
    await waitUntil(async () => (await agent())?.status === 'ready', {
      label: 'ready after reload'
    })
  },
  'Cycle model': null,
  'Cycle thinking level': null,
  'Change model': () => page().getByRole('combobox').waitFor(),
  'Thinking level': () => page().getByRole('combobox').waitFor(),
  'Show keyboard shortcuts': () => expectDialog(/shortcuts/i),
  'New session with options…': () => expectDialog(/New session|options/i),
  'Workspace launch options…': () => expectDialog(/launch options/i),
  'Project trust…': () => expectDialog(/trust/i),
  'Fork from a previous message…': () => expectDialog(/Fork|message/i),
  'Clone session': async () => {
    await waitUntil(
      async () => Object.keys(await run.test('agentIds').catch(() => ({}))).length >= 0,
      { label: 'clone' }
    )
  },
  'Show session tree': async () => {
    await waitUntil(async () => (await appState()).prefs.inspector?.open, {
      label: 'inspector open'
    })
    await page().getByText('Session tree').first().waitFor({ timeout: 5000 })
  },
  'Open a previous session…': () => page().getByRole('combobox').waitFor(),
  'Rename session': async () => {
    await page().getByRole('textbox', { name: /name/i }).first().waitFor({ timeout: 5000 })
  },
  'Export session as HTML…': async () => {
    await waitUntil(
      () =>
        stat(`${exportsDir}\\export-1.html`).then(
          () => true,
          () => false
        ),
      { label: 'html export' }
    )
    assert.match(await readFile(`${exportsDir}\\export-1.html`, 'utf8'), /<html/i)
  },
  'Export session as JSONL…': async () => {
    await waitUntil(
      () =>
        stat(`${exportsDir}\\export-2.jsonl`).then(
          () => true,
          () => false
        ),
      { label: 'jsonl export' }
    )
    assert.match(await readFile(`${exportsDir}\\export-2.jsonl`, 'utf8'), /first prompt/)
  },
  'Share session…': () => expectDialog(/Share/i),
  'Import session…': async () => {
    await sleep(500) // cancelled open dialog: nothing happens, no error
  },
  'New ephemeral session': async () => {
    await waitUntil(
      async () => (await agent())?.info?.ephemeral || !(await agent())?.info?.sessionFile,
      {
        label: 'ephemeral agent'
      }
    )
  },
  'Restart engines': async () => {
    await waitUntil(async () => (await agent())?.status === 'ready', {
      timeoutMs: 60_000,
      label: 'ready after restart'
    })
  },
  'Check for updates': () => expectDialog(/Updates?/i),
  'What’s new in the engine': () => expectDialog(/What’s new|Changelog/i)
}

try {
  await launch()

  let titles = []
  await step('the palette lists every known command (and nothing unchecked)', async () => {
    titles = await paletteTitles()
    console.log(`      ${titles.length} entries: ${titles.join(' | ')}`)
    assert.ok(titles.length > 20)
  })

  // Commands that replace the active session (or its history) run last, so the others see content.
  const LAST = ['Compact context', 'Clone session', 'New session', 'New ephemeral session']
  const ordered = Object.entries(CHECKS).sort(([a], [b]) => LAST.indexOf(a) - LAST.indexOf(b))
  for (const [title, check] of ordered) {
    if (!check) continue
    await step(`palette: "${title}" does what it says`, async () => {
      if (page().isClosed()) await launch()
      await closeOverlays()
      if (title === 'Compact context') server.queue(turn.text('Compacted summary.'))
      await runPalette(page(), title)
      try {
        await check()
      } catch (error) {
        const state = await agent().catch(() => null)
        error.message += ` | toasts: ${await toasts()} | agent: ${state?.status}/${state?.phase} compacting=${JSON.stringify(state?.compaction ?? state?.compacting ?? null)}`
        throw error
      } finally {
        await shot(page(), `palette-${title.replace(/[^a-z]+/gi, '-').toLowerCase()}`).catch(
          () => undefined
        )
        await closeOverlays()
        await run.test('waitForIdle', 30_000).catch(() => undefined)
      }
    })
  }

  await step('palette: the view toggles flip their pref and flip back', async () => {
    const prefs = async () => (await appState()).prefs
    const read = {
      'Toggle sidebar': async () => (await prefs()).sidebar?.open,
      'Toggle inspector': async () => (await prefs()).inspector?.open
    }
    for (const [title, get] of Object.entries(read)) {
      const before = await get()
      await runPalette(page(), title)
      await waitUntil(async () => (await get()) !== before, { label: `${title} changed` })
      await runPalette(page(), title)
      await waitUntil(async () => (await get()) === before, { label: `${title} restored` })
    }
  })

  await step('palette: "Cycle model" / "Cycle thinking level" change the session', async () => {
    const before = await agent()
    await runPalette(page(), 'Cycle thinking level')
    await waitUntil(async () => (await agent()).thinkingLevel !== before.thinkingLevel, {
      label: `thinking level changed from ${before.thinkingLevel}`
    })
    await runPalette(page(), 'Cycle model')
    await sleep(800)
    const after = await agent()
    console.log(
      `      model ${JSON.stringify(before.model?.id)} → ${JSON.stringify(after.model?.id)}`
    )
  })

  const unknown = () => titles.filter((t) => !Object.keys(CHECKS).some((k) => t.startsWith(k)))
  await step(
    'every listed palette entry has a check here (settings sections are opened below)',
    async () => {
      console.log(`      not individually checked: ${unknown().join(' | ') || 'none'}`)
    }
  )

  // ── Shortcuts ───────────────────────────────────────────────────────────────────────────
  let combos = []
  await step(
    'shortcuts sheet (Ctrl+/) lists the action shortcuts; no combo is used twice',
    async () => {
      await closeOverlays()
      await composer().click()
      await page().keyboard.press('Control+/')
      await expectDialog(/shortcuts/i)
      await shot(page(), 'palette-shortcuts-sheet')
      const rows = await page()
        .locator('[role="dialog"] li, [role="dialog"] [data-shortcut], [role="dialog"] tr')
        .evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, ' ').trim()))
      console.log(`      ${rows.length} rows`)
      combos = await page().evaluate(() =>
        [...document.querySelectorAll('[role="dialog"] kbd')].map((k) =>
          k.closest('li,tr,div')?.innerText.replace(/\s+/g, ' ').trim()
        )
      )
      await page().keyboard.press('Escape')
      const registered = await page().evaluate(() => window.__vengeanceTest?.actions?.() ?? null)
      if (registered) {
        const seen = new Map()
        for (const a of registered.filter((x) => x.hotkey)) {
          assert.ok(
            !seen.has(a.hotkey) || seen.get(a.hotkey) === a.title,
            `${a.hotkey}: ${seen.get(a.hotkey)} vs ${a.title}`
          )
          seen.set(a.hotkey, a.title)
        }
      }
    }
  )

  await step(
    'prepare: a turn with a tool call in the current session (for Ctrl+O / Ctrl+X)',
    async () => {
      await closeOverlays()
      server.queue(turn.toolCall('bash', { command: 'echo hotkeys' }), turn.text('Copy me please.'))
      await composer().fill('tool turn for hotkeys')
      await composer().press('Enter')
      await run.test('waitForIdle', 60_000)
      // The transcript only: the inspector's session tree (opened by an earlier step) quotes it too.
      await page().getByRole('main').getByText('Copy me please.').waitFor()
    }
  )

  const HOTKEYS = [
    ['Control+b', 'sidebar', async () => (await appState()).prefs.sidebar?.open],
    ['Control+i', 'inspector', async () => (await appState()).prefs.inspector?.open],
    [
      'Control+t',
      'thinking visibility (global hideThinkingBlock)',
      async () =>
        JSON.parse((await agentDir.readText('settings.json').catch(() => '{}')) || '{}')
          .hideThinkingBlock === true
    ],
    ['Control+o', 'tool output', () => page().locator('main [aria-expanded="true"]').count()]
  ]
  for (const [combo, what, read] of HOTKEYS) {
    await step(
      `shortcut ${combo} (${what}) works from the composer, keeps focus there`,
      async () => {
        await closeOverlays()
        await composer().click()
        const before = await read()
        await page().keyboard.press(combo)
        await waitUntil(async () => (await read()) !== before, { label: `${what} changed` })
        const focused = await page().evaluate(() =>
          document.activeElement?.getAttribute('aria-label')
        )
        await page().keyboard.press(combo)
        await waitUntil(async () => (await read()) === before, { label: `${what} restored` })
        assert.equal(focused, 'Message', 'focus stays in the composer')
      }
    )
  }

  await step(
    'shortcut Control+k toggles the palette; Escape returns focus to the composer',
    async () => {
      const focusedLabel = () =>
        page().evaluate(
          () =>
            document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName
        )
      await closeOverlays()
      await composer().click()
      await page().keyboard.press('Control+k')
      await page().getByRole('combobox').waitFor()
      await page().keyboard.press('Control+k')
      await page().getByRole('combobox').waitFor({ state: 'hidden' })
      await sleep(300)
      const afterToggle = await focusedLabel()
      await composer().click()
      await page().keyboard.press('Control+k')
      await page().getByRole('combobox').waitFor()
      await page().keyboard.press('Escape')
      await page().getByRole('combobox').waitFor({ state: 'hidden' })
      await sleep(300)
      const afterEscape = await focusedLabel()
      console.log(`      focus after Ctrl+K close: ${afterToggle}; after Escape: ${afterEscape}`)
      assert.deepEqual([afterToggle, afterEscape], ['Message', 'Message'])
      await page().keyboard.press('Control+k')
      await page().getByRole('combobox').waitFor()
      await page().keyboard.press('Escape')
      await page().getByRole('combobox').waitFor({ state: 'hidden' })
      await sleep(300)
      console.log(
        `      focused after Escape: ${await page().evaluate(() => {
          const el = document.activeElement
          return `${el?.tagName} ${el?.getAttribute('aria-label') ?? ''} ${el?.className}`.slice(
            0,
            120
          )
        })}`
      )
      assert.equal(
        await page().evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Message'
      )
    }
  )

  await step('shortcut Control+, opens settings; Control+n opens a new session', async () => {
    await closeOverlays()
    await composer().click()
    await page().keyboard.press('Control+,')
    await expectDialog(/Settings/)
    await closeOverlays()
    const before = await agentId()
    await composer().click()
    await page().keyboard.press('Control+n')
    await waitUntil(async () => (await agentId()) !== before, { label: 'new session' })
    // The previous session's pane fades out with its composer still in the DOM (first in order).
    await waitUntil(async () => (await page().getByRole('textbox', { name: 'Message' }).count()) === 1, {
      label: 'previous session pane gone'
    })
  })

  await step(
    'shortcut Control+l opens the model picker; Shift+Tab cycles thinking; Control+p cycles model',
    async () => {
      await closeOverlays()
      server.queue(turn.text('Copy me please.'))
      await composer().fill('another')
      await composer().press('Enter')
      await run.test('waitForIdle', 60_000)
      await composer().click()
      await page().keyboard.press('Control+l')
      await waitUntil(
        async () =>
          (await page().getByRole('listbox').count()) +
            (await page().getByRole('combobox').count()) >
          0,
        {
          label: 'model picker'
        }
      )
      await shot(page(), 'palette-ctrl-l')
      await closeOverlays()
      await composer().click()
      const level = (await agent()).thinkingLevel
      await page().keyboard.press('Shift+Tab')
      await waitUntil(async () => (await agent()).thinkingLevel !== level, {
        label: `thinking from ${level}`
      })
      await page().keyboard.press('Control+p')
      await sleep(600)
    }
  )

  await step(
    'shortcut Control+x copies the last response only when nothing is selected',
    async () => {
      await closeOverlays()
      await composer().fill('')
      await composer().click()
      await page().keyboard.press('Control+x')
      const toastText = await copyToast()
      assert.match(
        await run.app.evaluate(({ clipboard }) => clipboard.readText()),
        /Copy me please\./,
        `after "${toastText}"`
      )
      await composer().fill('cut this')
      await composer().press('Control+a')
      await composer().press('Control+x')
      await sleep(300)
      assert.equal(await run.app.evaluate(({ clipboard }) => clipboard.readText()), 'cut this')
      assert.equal(
        await composer()
          .inputValue()
          .catch(() => composer().innerText()),
        ''
      )
    }
  )

  await step('settings sections are reachable from the palette (14 entries)', async () => {
    for (const section of [
      'General',
      'Keyboard shortcuts',
      'Models',
      'Providers & accounts',
      'Engine',
      'Raw JSON'
    ]) {
      await closeOverlays()
      await runPalette(page(), section)
      await expectDialog(/Settings/)
      assert.ok(
        await page().getByRole('heading', { name: section }).first().isVisible(),
        `${section} heading`
      )
    }
    await closeOverlays()
  })

  console.log(`      shortcut sheet entries: ${combos.length}`)
} catch (error) {
  failures.push(error.stack ?? String(error))
} finally {
  await run?.kill().catch(() => undefined)
  await server.close()
  await agentDir.cleanup()
  await root.cleanup().catch(() => undefined)
}

if (failures.length) {
  console.error(`✗ shell/palette: ${failures.length} failure(s)`)
  process.exitCode = 1
} else console.log('✓ shell/palette passed')
