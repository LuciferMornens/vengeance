import { execFile } from 'node:child_process'
import type { ShareReadiness, ShareSessionResult } from '@shared/api/sessions'
import { childBaseEnv, shellEnvironmentReady } from '../../shell-env'

/** Engine 2 shares its native HTML export through the GitHub CLI. */

async function run(
  command: string,
  args: string[],
  timeout: number
): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }> {
  await shellEnvironmentReady()
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout, env: childBaseEnv() }, (error, stdout, stderr) => {
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
  if (version.missing) return { ready: false, destination: 'gist', reason: 'missing-gh' }
  const auth = await run('gh', ['auth', 'status'], 15_000)
  if (auth.code !== 0)
    return {
      ready: false,
      destination: 'gist',
      reason: 'signed-out',
      detail: (auth.stderr || auth.stdout).trim().split('\n')[0]
    }
  return { ready: true, destination: 'gist' }
}

/** Upload an HTML export as a secret gist; returns the viewer link and the gist URL. */
export async function uploadGistHtml(
  htmlPath: string
): Promise<Extract<ShareSessionResult, { destination: 'gist' }>> {
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
  return { destination: 'gist', url: gistUrl, gistUrl }
}
