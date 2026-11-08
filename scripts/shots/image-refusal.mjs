// Engine 2 refuses an image turn on a text-only model without an image model: the composer says so before
// sending, and the refused turn shows its error under the message (no response follows it).
import { MOCK_WORKSPACE } from './lib/mock-paths.mjs'

const TEXT_ONLY = {
  value: 'openrouter/meta-llama/llama-3.3-70b-instruct',
  name: 'Llama 3.3 70B Instruct'
}
// Engine 2 0.10.2's refusal, as its daemon settles the turn.
const REFUSAL =
  'This turn attaches images, but the selected model (openrouter/meta-llama/llama-3.3-70b-instruct) does not accept image input.\n\nPick one:\n- Switch the session model to an image-capable one with /model, or\n- Set imageModel in settings.json to an image-capable model ("provider/model-id" or a bare id), e.g. "anthropic/claude-sonnet-4-5"\n\nThen resend the message. Without it the request would silently drop the images.'
const PROMPT = 'What does this dashboard mockup show?'

export async function scenarios(page, { app, shot, test }) {
  await test('setPrefs', { onboardingCompleted: true, theme: 'dark' })
  const agentId = await test('openWorkspace', MOCK_WORKSPACE, { engine: 'prime' })
  const send = (event) =>
    app.evaluate(
      ({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0].webContents.send('engine:event', payload)
      },
      { agentId, event }
    )
  const composer = page.locator('[data-composer]')
  await composer.getByRole('button', { name: /^Model:/ }).click()
  await page.getByPlaceholder('Search models…').fill(TEXT_ONLY.name)
  await page.locator(`[cmdk-item][data-value="${TEXT_ONLY.value}"]`).click()
  await composer.locator(`button[aria-label="Model: ${TEXT_ONLY.name}"]`).waitFor()

  const image = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(960, 600)
    const g = canvas.getContext('2d')
    const gradient = g.createLinearGradient(0, 0, 960, 600)
    gradient.addColorStop(0, 'hsl(210 70% 52%)')
    gradient.addColorStop(1, 'hsl(260 60% 28%)')
    g.fillStyle = gradient
    g.fillRect(0, 0, 960, 600)
    g.fillStyle = 'rgba(255,255,255,0.85)'
    for (let row = 0; row < 5; row++) g.fillRect(96, 120 + row * 80, 280 + (row % 3) * 120, 28)
    const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const data = btoa(binary)
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([bytes], 'dashboard-mockup.png', { type: 'image/png' }))
    document
      .querySelector('textarea[aria-label="Message"]')
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true })
      )
    return { type: 'image', data, mimeType: 'image/png' }
  })
  await page.locator('[data-image-notice="danger"]').waitFor()
  await page.locator('textarea[aria-label="Message"]').fill(PROMPT)
  await page.mouse.move(760, 300)
  await page.evaluate(() => document.activeElement?.blur())
  await shot('engine2-image-refusal-composer')

  // Engine 2 records the message, then settles the turn with its refusal (the main adapter's turn_failed).
  await page.getByRole('button', { name: 'Remove dashboard-mockup.png' }).click()
  await page.locator('textarea[aria-label="Message"]').fill('')
  const user = {
    role: 'user',
    content: [{ type: 'text', text: PROMPT }, image],
    timestamp: Date.now()
  }
  await send({ type: 'message_start', message: user })
  await send({ type: 'message_end', message: user })
  await send({ type: 'turn_end' })
  await send({ type: 'turn_failed', error: REFUSAL })
  await page.getByText(`${TEXT_ONLY.name} can’t read images`, { exact: true }).waitFor()
  await shot('engine2-image-refusal-turn')

  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await shot('engine2-image-refusal-details')
  await page.getByRole('button', { name: 'Hide details', exact: true }).click()

  await test('setPrefs', { theme: 'light' })
  await shot('engine2-image-refusal-turn-light')
}
