import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

// Windows paths are case-insensitive but Rollup module ids are not. A build started from `d:\coding` while the folder
// is `D:\Coding` resolves some imports through realpath and some not, bundling two copies of a module (two app-state
// stores, one overwriting the other's prefs on quit). Pin every root to the on-disk casing.
const root = realpathSync.native(__dirname)
const shared = resolve(root, 'src/shared')

/** Fails the build when two bundled module ids differ only by letter case, i.e. one module bundled twice. */
function singleModuleCopies(): Plugin {
  return {
    name: 'vengeance-single-module-copies',
    buildEnd(error) {
      if (error) return
      const seen = new Map<string, string>()
      for (const id of this.getModuleIds()) {
        const other = seen.get(id.toLowerCase())
        if (other !== undefined && other !== id)
          this.error(`Bundled twice under different letter case:\n  ${other}\n  ${id}`)
        seen.set(id.toLowerCase(), id)
      }
    }
  }
}

/** Strict CSP for the packaged renderer; the dev server additionally needs inline HMR preamble + websocket. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'vengeance-csp',
    transformIndexHtml(_html, ctx) {
      const dev = Boolean(ctx.server)
      const policy = [
        "default-src 'self'",
        dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        dev ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'"
      ].join('; ')
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  main: {
    root,
    plugins: [singleModuleCopies()],
    resolve: { alias: { '@shared': shared } },
    build: {
      minify: 'esbuild',
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          // A child process run by the engine's node from outside app.asar (provider-host.ts): it must not share chunks.
          'provider-host': resolve(root, 'src/main/features/settings/provider-host-entry.ts')
        }
      }
    }
  },
  preload: {
    root,
    plugins: [singleModuleCopies()],
    resolve: { alias: { '@shared': shared } },
    build: {
      minify: 'esbuild',
      externalizeDeps: true,
      rollupOptions: { input: resolve(root, 'src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    worker: { format: 'es' },
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(root, 'src/renderer')
      }
    },
    plugins: [singleModuleCopies(), contentSecurityPolicy(), react(), tailwindcss()],
    build: {
      // electron-vite leaves the renderer unminified by default; minify so the main chunk stays small.
      minify: 'esbuild',
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') }
    }
  }
})
