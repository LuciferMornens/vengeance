import type { BridgeRequest, BridgeResult, BridgeToolsState } from '@shared/api/engine'
import type { SpeedMode, SpeedState } from '@shared/api/speed'
import { stringValue, type PrimeRecord } from './transport'

export async function callPrimeBridge(
  request: BridgeRequest,
  nativeCommand: (type: string, payload?: PrimeRecord) => Promise<PrimeRecord>,
  toolState: () => Promise<BridgeToolsState>,
  readSpeed: (mode?: SpeedMode) => Promise<SpeedState>
): Promise<BridgeResult> {
  switch (request.op) {
    case 'tree': {
      const result = await nativeCommand('navigate_tree', {
        targetId: request.entryId,
        summarize: request.summarize,
        customInstructions: request.customInstructions,
        replaceInstructions: request.replaceInstructions,
        label: request.label
      })
      const state = await nativeCommand('get_state')
      return {
        cancelled: result.cancelled === true,
        leafId: stringValue(result.leafId) ?? stringValue(state.leafId) ?? null,
        editorText: stringValue(result.editorText) ?? stringValue(result.selectedText)
      }
    }
    case 'label':
      await nativeCommand('set_session_entry_label', {
        entryId: request.entryId,
        label: request.label ?? null
      })
      return null
    case 'reload':
      await nativeCommand('reload')
      return null
    case 'tools-get':
      return toolState()
    case 'tools-set': {
      const state = await toolState()
      if (
        request.names.length !== state.active.length ||
        request.names.some((name) => !state.active.includes(name))
      ) {
        throw new Error(
          'Engine 2 manages its core tools. Configure skills and connections in settings.'
        )
      }
      return state
    }
    case 'subagents':
      if (request.method === 'status' || request.method === 'ping') {
        return { success: true, data: await nativeCommand('get_rlm_children') }
      }
      return {
        success: false,
        error: {
          code: 'unavailable',
          message: 'Use the native agent controls for this operation.'
        }
      }
    case 'speed':
      return readSpeed(request.mode)
    case 'system-prompt': {
      const response = await nativeCommand('get_system_prompt')
      if (typeof response.systemPrompt !== 'string') {
        throw new Error('Engine 2 did not return its active system instructions')
      }
      return { text: response.systemPrompt }
    }
  }
}
