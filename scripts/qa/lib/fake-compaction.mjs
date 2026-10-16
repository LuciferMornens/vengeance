/** Checkpoint output for Responses fixtures, including malformed/duplicate test cases. */
export function fakeCompactionItems(request, fakeTurn, ids) {
  const triggered = request.body?.input?.at(-1)?.type === 'compaction_trigger'
  const managed = request.body?.context_management?.some((entry) => entry.type === 'compaction')
  if (!triggered && !managed) return []
  if (fakeTurn.compactionItems) return fakeTurn.compactionItems
  const id = ids.next('cmp_qa_')
  return [{ type: 'compaction', id, encrypted_content: `qa-compaction-${id}` }]
}
