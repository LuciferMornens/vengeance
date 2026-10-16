import type { PrimeRecord } from './transport'

export const FACTORY_SPEC_ID = 'release-check'

const FACTORY_MACHINE = {
  run: { maxParallel: 2, maxTransitions: 12, failurePolicy: 'escalate', maxChildren: 8 },
  states: [
    { id: 'inspect', entry: true, lifecycle: 'task', maxEntries: 1, retries: 0 },
    { id: 'verify', entry: false, lifecycle: 'task', maxEntries: 2, retries: 1 },
    { id: 'package', entry: false, lifecycle: 'task', maxEntries: 1, retries: 0 }
  ],
  transitions: [
    { from: 'inspect', to: 'verify', on: 'settled' },
    { from: 'verify', to: 'package', on: 'settled' }
  ],
  order: ['inspect', 'verify', 'package']
}

export function factorySnapshot(runId: string | null, state = 'running'): PrimeRecord {
  return {
    runId,
    specId: FACTORY_SPEC_ID,
    name: runId ? 'Release readiness' : null,
    state: runId ? state : null,
    pauseReason: state === 'paused' ? 'Review the smoke-check result before resuming.' : null,
    elapsedMs: runId ? 73_000 : 0,
    machine: structuredClone(FACTORY_MACHINE),
    nodes: runId
      ? [
          { id: 'inspect', status: 'done', running: 0, queued: 0, attempts: 1 },
          {
            id: 'verify',
            status: state === 'paused' ? 'error' : 'running',
            running: state === 'paused' ? 0 : 1,
            queued: 0,
            attempts: 1,
            ...(state === 'paused' ? { error: 'Smoke check needs a test service.' } : {})
          },
          { id: 'package', status: 'pending', running: 0, queued: 0, attempts: 0 }
        ]
      : [],
    activeNodes: runId && state !== 'paused' ? ['verify'] : [],
    lastFired: runId ? [{ from: 'inspect', to: 'verify', seq: 1 }] : [],
    events: [],
    usage: runId
      ? {
          running: state === 'paused' ? 0 : 1,
          settled: 1,
          spawns: 2,
          toolUses: 19,
          maxParallel: 2,
          maxChildren: 8,
          transitionsFired: 1
        }
      : null,
    budget: { limitMs: 600_000, consumedMs: runId ? 73_000 : 0 }
  }
}
