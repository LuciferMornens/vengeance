// Main-process stubs for the sessions suites (Electron's native dialogs cannot be driven by Playwright):
// answer the next save/open dialog with a path, and replace the share upload so no gist is ever created.

/** The next `dialog.showSaveDialog` returns `filePath` (null = cancelled); records the options it got. */
export async function answerSaveDialog(app, filePath) {
  await app.app.evaluate(({ dialog }, target) => {
    globalThis.__qaSaveDialogs ??= []
    dialog.showSaveDialog = async (...args) => {
      const options = args.length > 1 ? args[1] : args[0]
      globalThis.__qaSaveDialogs.push({
        title: options?.title,
        defaultPath: options?.defaultPath,
        filters: options?.filters
      })
      return target
        ? { canceled: false, filePath: target }
        : { canceled: true, filePath: undefined }
    }
  }, filePath)
}

export async function saveDialogCalls(app) {
  return app.app.evaluate(() => globalThis.__qaSaveDialogs ?? [])
}

/** The next `dialog.showOpenDialog` returns `filePath` (null = cancelled). */
export async function answerOpenDialog(app, filePath) {
  await app.app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () =>
      target ? { canceled: false, filePaths: [target] } : { canceled: true, filePaths: [] }
  }, filePath)
}

/**
 * Replace `sessions:share` (the gist upload) with a recorder that never touches the network, and
 * `sessions:share-readiness` with a fixed answer. Returns nothing; read calls with `shareCalls()`.
 * Handlers answer with the app's invoke envelope (`{ ok, value }`, src/main/ipc/handle.ts).
 */
export async function stubShare(app, readiness = { ready: true }) {
  await app.app.evaluate(({ ipcMain }, answer) => {
    globalThis.__qaShareCalls ??= []
    globalThis.__qaReadinessCalls ??= 0
    ipcMain.removeHandler('sessions:share')
    ipcMain.handle('sessions:share', async (_event, ...args) => {
      globalThis.__qaShareCalls.push(args)
      return {
        ok: true,
        value: {
          url: 'https://share.qa.invalid/session/#qa-gist-id',
          gistUrl: 'https://gist.qa.invalid/qa/qa-gist-id'
        }
      }
    })
    ipcMain.removeHandler('sessions:share-readiness')
    ipcMain.handle('sessions:share-readiness', async () => {
      globalThis.__qaReadinessCalls++
      return { ok: true, value: answer }
    })
  }, readiness)
}

export async function shareCalls(app) {
  return app.app.evaluate(() => ({
    uploads: globalThis.__qaShareCalls ?? [],
    readinessChecks: globalThis.__qaReadinessCalls ?? 0
  }))
}

/** Record `shell.trashItem` calls (the real one still runs on the temp file). */
export async function recordTrash(app) {
  await app.app.evaluate(({ shell }) => {
    if (globalThis.__qaTrash) return
    globalThis.__qaTrash = []
    const original = shell.trashItem.bind(shell)
    shell.trashItem = async (path) => {
      globalThis.__qaTrash.push(path)
      return original(path)
    }
  })
}

export async function trashCalls(app) {
  return app.app.evaluate(() => globalThis.__qaTrash ?? [])
}
