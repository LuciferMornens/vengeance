import { execFile } from 'node:child_process'
import type { SystemPromptDefault } from '@shared/api/settings'
import { childBaseEnv, shellEnvironmentReady } from '../../shell-env'
import { primeHelperPath } from './helper'
import { jsonObject } from './configuration-store'

const HELPER_PROTOCOL_VERSION = 1
const HELPER_UPSTREAM_REVISION = '8aac8692456c00c01d4e53e60e6d3347a3506559'
const PROMPT_TIMEOUT_MS = 15_000
const MAX_PROMPT_BYTES = 1024 * 1024

export async function primeDefaultSystemPrompt(): Promise<SystemPromptDefault> {
  await shellEnvironmentReady()
  return new Promise((resolve, reject) => {
    execFile(
      primeHelperPath(),
      ['--system-prompt-default'],
      {
        env: childBaseEnv(),
        windowsHide: true,
        timeout: PROMPT_TIMEOUT_MS,
        maxBuffer: MAX_PROMPT_BYTES
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Engine 2 could not read its built-in prompt. Try again.'))
          return
        }
        try {
          const response = jsonObject(JSON.parse(stdout))
          const result = jsonObject(response?.result)
          if (
            response?.ok !== true ||
            response.protocol !== HELPER_PROTOCOL_VERSION ||
            response.revision !== HELPER_UPSTREAM_REVISION ||
            typeof result?.text !== 'string'
          )
            throw new Error('The Engine 2 helper does not support this built-in prompt view.')
          resolve({ text: result.text })
        } catch (failure) {
          reject(failure)
        }
      }
    )
  })
}
