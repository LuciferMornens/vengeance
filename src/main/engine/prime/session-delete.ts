import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, rm, rmdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, shell } from 'electron'
import type { SessionLineage } from '@shared/api/sessions'
import { connectPrimeResident } from './daemon'
import { getPrimeAgentDir } from './locate'
import { nativePrimeDeleteChild } from './sessions-native'

async function regularFile(path: string): Promise<boolean> {
  return stat(path).then(
    (metadata) => metadata.isFile(),
    () => false
  )
}

async function saveRecoveryCopy(path: string, recoveryPath: string): Promise<void> {
  await copyFile(path, recoveryPath, constants.COPYFILE_EXCL)
  const recovery = await open(recoveryPath, 'r+')
  try {
    await recovery.sync()
  } finally {
    await recovery.close()
  }
}

export async function deletePrimeChildSession(
  path: string,
  sessionId: string,
  lineage: SessionLineage,
  sessionDirs: string[],
  overridePath?: string | null
): Promise<void> {
  const parentPath = lineage.parentSessionPath
  const childId = lineage.childId
  if (!parentPath || !childId) {
    throw new Error('Engine 2 could not verify this child’s native parent')
  }
  const recoveryRoot = join(app.getPath('userData'), 'session-recovery', 'deleted')
  await mkdir(recoveryRoot, { recursive: true })
  const recoveryDirectory = await mkdtemp(join(recoveryRoot, 'child-'))
  const recoveryPath = join(recoveryDirectory, basename(path))
  try {
    const parent = await connectPrimeResident(
      { sessionPath: parentPath },
      { executablePath: overridePath }
    )
    if (parent) {
      try {
        await saveRecoveryCopy(path, recoveryPath)
        const result = await parent.client.request('delete_rlm_subagent', {
          activeSessionId: parent.nativeAgentId,
          childId
        })
        if (result.deleted !== true) {
          await rm(recoveryPath)
          throw new Error(
            result.reason === 'running'
              ? 'Stop the child’s current work before deleting its conversation'
              : 'Engine 2 could not verify this child in its parent’s native registry'
          )
        }
      } finally {
        parent.client.close()
      }
      if (await regularFile(path)) {
        await shell.trashItem(path)
        await rm(recoveryPath)
      } else {
        await shell.trashItem(recoveryPath)
      }
    } else {
      await nativePrimeDeleteChild({
        agentDir: getPrimeAgentDir(),
        sessionDirs,
        path,
        parentPath,
        sessionId,
        childId,
        recoveryPath
      })
      await shell.trashItem(recoveryPath)
    }
    await rmdir(recoveryDirectory)
  } catch (error) {
    if (await regularFile(recoveryPath)) {
      const message = error instanceof Error ? error.message : 'Child deletion could not complete'
      throw new Error(`${message}. Recovery copy: ${recoveryPath}`, { cause: error })
    }
    await rmdir(recoveryDirectory).catch(() => undefined)
    throw error
  }
}
