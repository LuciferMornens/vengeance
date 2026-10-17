/** Process-level flags read once at startup. */
function flag(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true'
}

export const env = {
  /** Scripted MockEngineProcess instead of real pi processes. */
  mock: flag('VENGEANCE_MOCK'),
  /** Test harness mode: exposes `window.__vengeanceTest`, deterministic window. */
  test: flag('VENGEANCE_TEST'),
  /** Force a solid window background (screenshots cannot capture Mica). */
  noMica: flag('VENGEANCE_NO_MICA'),
  /** Children keep the launch environment instead of the login shell's (macOS, Linux; see shell-env.ts). */
  skipShellEnv: flag('VENGEANCE_SKIP_SHELL_ENV'),
  /** Linux window controls: `native` (Electron's caption buttons) or `none` (frameless) instead of by desktop. */
  windowControls: process.env.VENGEANCE_WINDOW_CONTROLS || null,
  /** Override Electron's userData dir (isolated test profiles). */
  userDataDir: process.env.VENGEANCE_USER_DATA || null,
  /** Dev server URL injected by electron-vite in `npm run dev`. */
  rendererUrl: process.env.ELECTRON_RENDERER_URL || null
} as const
