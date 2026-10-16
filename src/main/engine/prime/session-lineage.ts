import type { SessionIdentity } from '@shared/api/sessions'
import type { RpcSessionState } from '@shared/engine-types'
import { samePath } from '../../paths'
import { primeSessionIdentity } from './sessions'

export class PrimeSessionLineage {
  private path: string | undefined
  private saved: { path: string; identity: SessionIdentity } | undefined

  async load(path: string | undefined, nativeDepth?: unknown): Promise<void> {
    if (nativeDepth === 0) {
      this.path = undefined
      this.saved = undefined
      return
    }
    if (this.path === path) return
    this.path = path
    this.saved = undefined
    if (!path) return
    const identity = await primeSessionIdentity(path).catch(() => null)
    if (this.path === path && identity?.lineage) this.saved = { path, identity }
  }

  apply(state: RpcSessionState): RpcSessionState {
    if (!this.saved || !state.sessionFile || !samePath(state.sessionFile, this.saved.path)) {
      return state
    }
    // A reopened child can become a native top-level resident while its saved ledger edge remains.
    return {
      ...state,
      lineage: { ...state.lineage, ...this.saved.identity.lineage }
    }
  }
}
