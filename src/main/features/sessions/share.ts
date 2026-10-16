import { execFile } from 'node:child_process'
import type { ShareReadiness, ShareSessionResult } from '@shared/api/sessions'
import { piConfig, type PiConfigModule } from '../settings/pi-modules'

/**
 * `/share` for the desktop, following the engine's `session-share.js` gist path: the HTML export is
 * uploaded as a secret gist with the GitHub CLI, and the link opens it in the engine's share viewer
 * (`getShareViewerUrl`, which honours `PI_SHARE_VIEWER_URL`).
 */

function run(
  command: string,
  args: string[],
  timeout: number
): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: string | number }) | null
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        missing: err?.code === 'ENOENT'
      })
    })
  })
}

export async function shareReadiness(): Promise<ShareReadiness> {
  const version = await run('gh', ['--version'], 10_000)
  if (version.missing) return { ready: false, reason: 'missing-gh' }
  const auth = await run('gh', ['auth', 'status'], 15_000)
  if (auth.code !== 0)
    return {
      ready: false,
      reason: 'signed-out',
      detail: (auth.stderr || auth.stdout).trim().split('\n')[0]
    }
  return { ready: true }
}

/** Upload an HTML export as a secret gist; returns the viewer link and the gist URL. */
export async function uploadGistHtml(htmlPath: string): Promise<ShareSessionResult> {
  const readiness = await shareReadiness()
  if (!readiness.ready) {
    throw new Error(
      readiness.reason === 'missing-gh'
        ? 'The GitHub CLI (gh) is not installed.'
        : 'The GitHub CLI is not signed in. Run "gh auth login" first.'
    )
  }
  const result = await run('gh', ['gist', 'create', '--public=false', htmlPath], 120_000)
  if (result.code !== 0)
    throw new Error(`Could not create the gist: ${result.stderr.trim() || 'unknown error'}`)
  const gistUrl = result.stdout.trim().split('\n').pop()?.trim() ?? ''
  const gistId = gistUrl.split('/').pop()
  if (!gistUrl || !gistId) throw new Error('Could not read the gist link from the GitHub CLI')
  return { url: gistUrl, gistUrl }
}

export async function uploadGist(
  overridePath: string | null,
  htmlPath: string
): Promise<ShareSessionResult> {
  const { gistUrl } = await uploadGistHtml(htmlPath)
  const gistId = gistUrl.split('/').pop()!
  const config = await piConfig(overridePath).catch((): Partial<PiConfigModule> => ({}))
  return { url: config.getShareViewerUrl ? config.getShareViewerUrl(gistId) : gistUrl, gistUrl }
}
