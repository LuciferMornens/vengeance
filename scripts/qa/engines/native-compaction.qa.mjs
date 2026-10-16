import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { assertTempPath } from '../lib/agent-dir.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { submitCommand, until } from '../chat/helpers.mjs'
import {
  checkpointItems,
  compactionFixture,
  nativeRequest,
  ordinaryRequest,
  summaryRequest,
  TASK,
  verifyFinishedTask
} from '../lib/native-compaction-fixture.mjs'

for (const engine of ['pi', 'prime']) {
  if (process.env.QA_COMPACTION_ENGINE && process.env.QA_COMPACTION_ENGINE !== engine) continue
  for (const subscription of engine === 'pi' ? [false, true, 'codex'] : [false, true]) {
    const route = subscription === 'codex' ? 'codex' : subscription ? 'chatgpt' : 'api'
    console.log(`▶ Native compaction: ${engine}, ${route}`)
    const test = await compactionFixture(engine, subscription)
    const { app, agentId, server } = test
    try {
      const read =
        engine === 'pi'
          ? turn.toolCall('read', { path: 'operands.txt' }, { when: ordinaryRequest })
          : turn.toolCall(
              'ipython',
              { code: 'from pathlib import Path\nprint(Path("operands.txt").read_text())' },
              { when: ordinaryRequest }
            )
      const write =
        engine === 'pi'
          ? turn.toolCall(
              'write',
              { path: 'result.txt', content: '323\n' },
              { when: ordinaryRequest }
            )
          : turn.toolCall(
              'ipython',
              { code: 'from pathlib import Path\nPath("result.txt").write_text("323\\n")' },
              { when: ordinaryRequest }
            )
      server.queue(
        read,
        turn.error(400, {
          message: 'prompt is too long: 300000 tokens > 272000 maximum',
          when: ordinaryRequest
        }),
        turn.text('The user needs 17 times 19 saved in result.txt, then a report.', {
          when: summaryRequest
        }),
        turn.text('The operands were read. Finish writing and report.', { when: summaryRequest }),
        turn.text('', { when: nativeRequest }),
        write,
        turn.text('Saved result.txt. Result: 323.', { when: ordinaryRequest })
      )
      await app.send(TASK)
      await server.waitForRequest(nativeRequest, { timeoutMs: 120000 })
      console.log(await verifyFinishedTask(test))
      await app.screenshot(`${engine}-${route}-finished`)
      server.reset()
      await app.invoke('engine:restart', agentId, undefined)
      await until(async () => (await app.agentState(agentId))?.status === 'ready', {
        label: 'restarted',
        timeoutMs: 120000
      })
      server.queue(turn.text('The saved result is 323.'))
      await app.send('What result did you save?')
      const reloaded = await server.waitForRequest(ordinaryRequest)
      await app.waitForSettle()
      assert.equal(checkpointItems(reloaded).length, 1, 'checkpoint survives native session reload')
      server.reset()
      server.queue(
        turn.text('Portable summary.', { when: summaryRequest }),
        turn.text('Prefix.', { when: summaryRequest }),
        turn.text('', { when: nativeRequest })
      )
      await submitCommand(app, '/compact')
      const repeated = await server.waitForRequest(nativeRequest)
      await app.waitForSettle()
      assert.equal(
        checkpointItems(repeated).length,
        1,
        'repeated compaction carries the old checkpoint'
      )
      if (engine === 'pi') {
        const { sessionFile } = await app.rpc({ type: 'get_state' }, agentId)
        assertTempPath(sessionFile)
        const rows = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(JSON.parse)
        for (const row of rows) {
          if (row.customType === 'vengeance-native-compaction') delete row.data.format
        }
        const legacy = rows.findLast((row) => row.customType === 'vengeance-native-compaction')
        assert.ok(legacy)
        await writeFile(sessionFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
        await app.invoke('engine:restart', agentId, undefined)
        await until(async () => (await app.agentState(agentId))?.status === 'ready', {
          label: 'legacy session restart'
        })
        server.reset()
        server.queue(turn.text('The result is 323.'))
        await app.send('Report the saved result.')
        const recovered = await server.waitForRequest(ordinaryRequest)
        await app.waitForSettle()
        assert.equal(checkpointItems(recovered).length, 0, 'legacy ciphertext is never replayed')
        assert.match(JSON.stringify(recovered.body.input), /Portable summary/)
        const recoveredRows = (await readFile(sessionFile, 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse)
        assert.deepEqual(
          recoveredRows.find((row) => row.id === legacy.id),
          legacy,
          'legacy record remains unchanged'
        )
      }
      for (const invalid of [
        { compactionItems: [] },
        { stopReason: 'length' },
        { compactionItems: [{ type: 'compaction', encrypted_content: '' }] },
        {
          compactionItems: [
            { type: 'compaction', encrypted_content: 'one' },
            { type: 'compaction', encrypted_content: 'two' }
          ]
        }
      ]) {
        server.reset()
        server.queue(turn.text('More conversation.'))
        await app.send('Keep the result in mind.')
        await app.waitForSettle()
        server.reset()
        server.queue(
          turn.text('Portable fallback summary.', { when: summaryRequest }),
          turn.text('Prefix.', { when: summaryRequest }),
          turn.text('', { ...invalid, when: nativeRequest })
        )
        await submitCommand(app, '/compact')
        await server.waitForRequest(nativeRequest)
        await app.waitForSettle()
        server.reset()
        server.queue(turn.text('The result is 323.'))
        await app.send('Report the saved result.')
        const fallback = await server.waitForRequest(ordinaryRequest)
        await app.waitForSettle()
        assert.equal(
          checkpointItems(fallback).length,
          0,
          'invalid checkpoint must leave the summary in place'
        )
        assert.match(JSON.stringify(fallback.body.input), /Portable fallback summary/)
      }
      server.reset()
      server.queue(turn.text('Before cancellation.'))
      await app.send('Keep the saved result.')
      await app.waitForSettle()
      server.reset()
      server.queue(
        turn.text('Portable summary before cancellation.', { when: summaryRequest }),
        turn.text('The task is complete.', { when: summaryRequest }),
        turn.hang({ when: nativeRequest })
      )
      await submitCommand(app, '/compact')
      const interrupted = await server.waitForRequest(nativeRequest)
      await until(
        () => {
          const summaries = server.requests.filter(summaryRequest)
          return (
            summaries.length > 0 && summaries.every((request) => request.outcome === 'completed')
          )
        },
        { label: 'text summary complete while native checkpoint is still streaming' }
      )
      await app.page.getByRole('button', { name: 'Stop', exact: true }).click()
      assert.equal(
        await server.waitForOutcome(interrupted),
        'aborted',
        'Stop cancels the native provider stream'
      )
      await app.waitForSettle()
      server.reset()
      server.queue(turn.text('The saved result is 323.'))
      await app.send('Report the saved result.')
      const afterAbort = await server.waitForRequest(ordinaryRequest)
      await app.waitForSettle()
      assert.equal(
        checkpointItems(afterAbort).length,
        0,
        'a cancelled partial checkpoint is never persisted'
      )
      app.assertNoErrors()
      console.log(
        '✓ task continuation, report, reload, repeated compaction, fallback and cancellation'
      )
    } catch (error) {
      await app.screenshot(`${engine}-${subscription}-FAILED`)
      console.error(
        server.requests.map((request) => ({
          index: request.index,
          path: request.path,
          native: nativeRequest(request),
          summary: summaryRequest(request),
          outcome: request.outcome
        }))
      )
      throw error
    } finally {
      await test.close()
    }
  }
}
