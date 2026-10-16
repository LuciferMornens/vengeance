/**
 * Pure checkpoint validation and replay helpers, usable without an Engine.
 */

export const NATIVE_COMPACTION_ENTRY = 'vengeance-native-compaction'
export const NATIVE_COMPACTION_FORMAT = 'responses-compaction-trigger-v1'

/** pi's `COMPACTION_SUMMARY_PREFIX` in dist/core/messages.js. */
const SUMMARY_MESSAGE_START =
  'The conversation history before this point was compacted into the following summary:'

export interface CompactionItem {
  type: 'compaction'
  id?: string
  encrypted_content: string
}

export interface NativeCompactionData {
  format: typeof NATIVE_COMPACTION_FORMAT
  compactionId: string
  model: string
  provider: string
  api: string
  baseUrl: string
  item: CompactionItem
}

interface ModelLike {
  provider?: string
  api?: string
  id?: string
  baseUrl?: string
}

export type Payload = Record<string, unknown> & { input?: unknown }

/** The fields of a pi `SessionEntry` read here. */
export interface BranchEntry {
  type: string
  id: string
  customType?: string
  data?: unknown
}

export function supportsNativeCompaction(
  model: ModelLike | undefined
): model is ModelLike & { id: string } {
  return (
    typeof model?.id === 'string' &&
    ((model.provider === 'openai' && model.api === 'openai-responses') ||
      (model.provider === 'openai-codex' && model.api === 'openai-codex-responses'))
  )
}

export function isCompactionItem(value: unknown): value is CompactionItem {
  const item = value as Partial<CompactionItem> | null
  return (
    typeof item === 'object' &&
    item !== null &&
    item.type === 'compaction' &&
    typeof item.encrypted_content === 'string' &&
    item.encrypted_content.length > 0
  )
}

function isNativeData(value: unknown): value is NativeCompactionData {
  const data = value as Partial<NativeCompactionData> | null
  // Unversioned checkpoints contain a synthetic user instruction and cannot be replayed safely.
  return (
    typeof data === 'object' &&
    data !== null &&
    data.format === NATIVE_COMPACTION_FORMAT &&
    typeof data.compactionId === 'string' &&
    typeof data.model === 'string' &&
    typeof data.provider === 'string' &&
    typeof data.api === 'string' &&
    typeof data.baseUrl === 'string' &&
    isCompactionItem(data.item)
  )
}

/** An opaque checkpoint belongs to the model and provider endpoint that generated it. */
export function nativeItemForBranch(
  branch: readonly BranchEntry[],
  model: ModelLike
): CompactionItem | undefined {
  const compactionIndex = branch.findLastIndex((entry) => entry.type === 'compaction')
  const compaction = branch[compactionIndex]
  if (!compaction) return undefined
  const data = branch
    .slice(compactionIndex + 1)
    .findLast(
      (entry) =>
        entry.type === 'custom' &&
        entry.customType === NATIVE_COMPACTION_ENTRY &&
        isNativeData(entry.data) &&
        entry.data.compactionId === compaction.id &&
        entry.data.model === model.id &&
        entry.data.provider === model.provider &&
        entry.data.api === model.api &&
        entry.data.baseUrl === model.baseUrl
    )?.data
  return isNativeData(data) ? data.item : undefined
}

function isUserMessage(value: unknown): value is { role: 'user'; content?: unknown } {
  return (
    typeof value === 'object' && value !== null && (value as { role?: unknown }).role === 'user'
  )
}

function isSummaryMessage(item: { content?: unknown }): boolean {
  const content = item.content
  const first =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content[0] as { text?: unknown } | undefined)?.text
        : undefined
  return typeof first === 'string' && first.startsWith(SUMMARY_MESSAGE_START)
}

/**
 * Replace only the leading summary. Later messages can quote its wording without being checkpoints.
 */
export function withNativeItem(payload: unknown, item: CompactionItem): Payload | undefined {
  const body = payload as Payload | null
  if (typeof body !== 'object' || body === null || !Array.isArray(body.input)) return undefined
  const index = body.input.findIndex(isUserMessage)
  if (index === -1 || !isSummaryMessage(body.input[index] as { content?: unknown }))
    return undefined
  const input = [...body.input]
  input[index] = {
    type: 'compaction',
    ...(item.id ? { id: item.id } : {}),
    encrypted_content: item.encrypted_content
  }
  return { ...body, input }
}
