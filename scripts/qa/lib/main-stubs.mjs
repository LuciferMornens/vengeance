// Main-process stubs (Electron's native dialogs cannot be driven by Playwright, and QA never uploads,
// opens a browser or trashes real files): answer save/open dialogs, record the share upload instead
// of creating a gist, record shell.trashItem, and fake main-process network calls.
// `app` is a QaApp from launchApp() (or anything with an `app` ElectronApplication).

/** The next `dialog.showSaveDialog` calls return `filePath` (null = cancelled); records the options. */
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

/** The next `dialog.showOpenDialog` calls (folder or file pickers) return `path` (null = cancelled). */
export async function answerOpenDialog(app, path) {
  await app.app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () =>
      target ? { canceled: false, filePaths: [target] } : { canceled: true, filePaths: [] }
  }, path)
}

/**
 * Replace `sessions:share` (the gist upload) with a recorder that never touches the network, and
 * `sessions:share-readiness` with a fixed answer; read the calls with `shareCalls()`. Handlers answer
 * with the app's invoke envelope (`{ ok, value }`, src/main/ipc/handle.ts).
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

/** Record `shell.trashItem` calls (the real one still runs; QA only trashes its own temp files). */
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

/**
 * Replace `shell.openExternal` (recorded, never opens a browser) and main's `fetch` for URLs that
 * start with a route `prefix` (canned JSON). Other URLs still go to the real fetch.
 *
 * @param {{ prefix: string, json: unknown, status?: number }[]} routes
 */
export async function stubMainNetwork(app, routes = []) {
  await app.app.evaluate(({ shell }, cannedRoutes) => {
    const state = (globalThis.__qaNetworkStub = { opened: [], fetched: [] })
    shell.openExternal = async (url) => {
      state.opened.push(String(url))
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input))
      const route = cannedRoutes.find((candidate) => url.startsWith(candidate.prefix))
      if (!route) return realFetch(input, init)
      state.fetched.push(url)
      return new Response(JSON.stringify(route.json), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  }, routes)
  return {
    opened: () => app.app.evaluate(() => [...globalThis.__qaNetworkStub.opened]),
    fetched: () => app.app.evaluate(() => [...globalThis.__qaNetworkStub.fetched])
  }
}
