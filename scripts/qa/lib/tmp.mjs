// QA temp folders: workspaces, agent dirs, profiles. They live OUTSIDE the user's profile, because the
// engine walks every ancestor of a workspace for project `.agents/skills` (and the app shows the Trust
// dialog for them); only `$HOME/.agents/skills` is exempt. Fake mode gives the app a temp HOME (so the
// user's real ~/.agents/skills never loads), which turns the real one into a project resource of any
// workspace below the profile. The default root sits next to the repo, never inside it: a git-ignored
// folder would hide the workspace's files from `git ls-files` and the engine's fd/rg tools.
//
//   QA_TMP_ROOT=<folder outside your profile and outside any git repo>   (default: <repo>/../.vengeance-qa-tmp)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const REAL_HOME = resolve(homedir())
export const QA_TMP_ROOT = resolve(
  process.env.QA_TMP_ROOT || join(REPO_ROOT, '..', '.vengeance-qa-tmp')
)

export function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Throws when `path` is inside the user's profile (workspaces and agent dirs never are). */
export function assertOutsideRealHome(path) {
  const target = resolve(path)
  if (isInside(REAL_HOME, target)) {
    throw new Error(
      `QA workspaces and agent dirs must live outside ${REAL_HOME} (got ${target}); set QA_TMP_ROOT`
    )
  }
  return target
}

/** A fresh folder `<QA_TMP_ROOT>/<prefix>XXXXXX`. */
export async function qaTempDir(prefix) {
  await mkdir(assertOutsideRealHome(QA_TMP_ROOT), { recursive: true })
  return mkdtemp(join(QA_TMP_ROOT, prefix))
}

/** A temp folder for one suite (profiles, workspaces, feeds); removed by `cleanup()`. */
export async function tempRoot(prefix = 'vengeance-qa-') {
  const dir = await qaTempDir(prefix)
  return {
    dir,
    path: (...parts) => join(dir, ...parts),
    /** `<dir>/<name>` with `files` (relative path → text or JSON). */
    async folder(name, files = {}) {
      const target = join(dir, name)
      await mkdir(target, { recursive: true })
      for (const [relativePath, content] of Object.entries(files)) {
        const file = join(target, relativePath)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(
          file,
          typeof content === 'string' ? content : JSON.stringify(content, null, 2)
        )
      }
      return target
    },
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
