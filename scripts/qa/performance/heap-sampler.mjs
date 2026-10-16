import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

function summarizeSnapshot(snapshot, closedAgentIds) {
  const metadata = snapshot.snapshot.meta
  const width = metadata.node_fields.length
  const sizeIndex = metadata.node_fields.indexOf('self_size')
  const closedIds = new Set(closedAgentIds)
  const presentIds = new Set()
  let codeBytes = 0
  let objectAndArrayBytes = 0
  let closureCount = 0
  for (let offset = 0; offset < snapshot.nodes.length; offset += width) {
    const type = metadata.node_types[0][snapshot.nodes[offset]]
    const name = snapshot.strings[snapshot.nodes[offset + 1]]
    const size = snapshot.nodes[offset + sizeIndex]
    if (type === 'code') codeBytes += size
    if (type === 'object' || type === 'array') objectAndArrayBytes += size
    if (type === 'closure') closureCount += 1
    if (type === 'string' && closedIds.has(name)) presentIds.add(name)
  }
  return { codeBytes, objectAndArrayBytes, closureCount, closedAgentIdsPresent: [...presentIds] }
}

export async function createHeapSampler(electronApplication, page) {
  const debuggerSession = await page.context().newCDPSession(page)
  let mainSampler
  try {
    mainSampler = await electronApplication.evaluateHandle(() => {
      const nativeV8 = process.getBuiltinModule('node:v8')
      const nativeVm = process.getBuiltinModule('node:vm')
      nativeV8.setFlagsFromString('--expose-gc')
      const collectGarbage = nativeVm.runInNewContext('gc')
      return () => {
        collectGarbage()
        const memory = process.memoryUsage()
        const heap = nativeV8.getHeapStatistics()
        const code = nativeV8.getHeapCodeStatistics()
        return {
          heapUsed: memory.heapUsed,
          rss: memory.rss,
          nativeContexts: heap.number_of_native_contexts,
          detachedContexts: heap.number_of_detached_contexts,
          codeBytes: code.code_and_metadata_size,
          bytecodeBytes: code.bytecode_and_metadata_size
        }
      }
    })
  } catch (error) {
    await debuggerSession.detach()
    throw error
  }

  return {
    async sample(label) {
      await debuggerSession.send('HeapProfiler.collectGarbage')
      const renderer = await debuggerSession.send('Runtime.getHeapUsage')
      const main = await mainSampler.evaluate((sampleHeap) => sampleHeap())
      return {
        label,
        rendererBytes: renderer.usedSize,
        rendererTotalBytes: renderer.totalSize,
        rendererEmbedderBytes: renderer.embedderHeapUsedSize,
        rendererBackingBytes: renderer.backingStorageSize,
        mainBytes: main.heapUsed,
        mainRss: main.rss,
        mainNativeContexts: main.nativeContexts,
        mainDetachedContexts: main.detachedContexts,
        mainCodeBytes: main.codeBytes,
        mainBytecodeBytes: main.bytecodeBytes
      }
    },

    async snapshot(path, closedAgentIds = []) {
      await mkdir(dirname(path), { recursive: true })
      const chunks = []
      const collectChunk = ({ chunk }) => chunks.push(chunk)
      debuggerSession.on('HeapProfiler.addHeapSnapshotChunk', collectChunk)
      try {
        await debuggerSession.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
        const contents = chunks.join('')
        await writeFile(path, contents)
        return summarizeSnapshot(JSON.parse(contents), closedAgentIds)
      } finally {
        debuggerSession.off('HeapProfiler.addHeapSnapshotChunk', collectChunk)
      }
    },

    async dispose() {
      try {
        await mainSampler.dispose()
      } finally {
        await debuggerSession.detach()
      }
    }
  }
}
