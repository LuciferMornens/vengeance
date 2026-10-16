import { useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Badge, Button, IconButton, Skeleton, Textarea } from '../../ui'
import { Markdown } from '../../ui/Markdown'
import {
  nativeNumber,
  nativeRecord,
  nativeRows,
  nativeText,
  PrimeFeedback,
  PrimeFormField,
  usePrimeAction,
  usePrimeQuery
} from './prime-runtime'
import { useSideQuestions } from './prime-side-questions'

function UsageValues({ value }: { value: unknown }) {
  const usage = nativeRecord(value)
  const tokens = nativeRecord(usage.tokens)
  const metrics = [
    ['Input', nativeNumber(tokens.input) ?? nativeNumber(usage.input)],
    ['Output', nativeNumber(tokens.output) ?? nativeNumber(usage.output)],
    ['Cached', nativeNumber(tokens.cacheRead) ?? nativeNumber(usage.cacheRead)],
    ['Total', nativeNumber(tokens.total) ?? nativeNumber(usage.totalTokens)]
  ] as const
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-2 text-xs tabular-nums">
      {metrics
        .filter((entry) => entry[1] !== undefined)
        .map(([label, value]) => (
          <div key={label} className="flex gap-1.5">
            <dt className="text-fg-3">{label}</dt>
            <dd className="text-fg-2">{value?.toLocaleString()}</dd>
          </div>
        ))}
    </dl>
  )
}

function ContextNode({ node, root = false }: { node: Record<string, unknown>; root?: boolean }) {
  const [expanded, setExpanded] = useState(root)
  const children = nativeRows(node.children)
  const model = nativeRecord(node.model)
  const context = nativeRecord(node.contextUsage)
  return (
    <div className={root ? '' : 'ml-4 border-l border-hairline-soft pl-4'}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md py-3 text-left hover:bg-hover"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-fg-3" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-fg-3" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {nativeText(node.label) || nativeText(node.id) || 'Session'}
        </span>
        {nativeText(node.status) && <Badge>{nativeText(node.status)}</Badge>}
      </button>
      {expanded && (
        <div className="space-y-3 pb-3">
          {nativeText(model.id) && (
            <p className="text-xs text-fg-3">
              {nativeText(model.provider)} · {nativeText(model.id)}
            </p>
          )}
          {nativeNumber(context.tokens) !== undefined && (
            <p className="text-xs tabular-nums text-fg-3">
              Context: {nativeNumber(context.tokens)?.toLocaleString()} tokens
              {nativeNumber(context.contextWindow) !== undefined
                ? ` of ${nativeNumber(context.contextWindow)?.toLocaleString()}`
                : ''}
            </p>
          )}
          <UsageValues value={node.totalUsage} />
          {children.map((child, index) => (
            <ContextNode key={nativeText(child.id) || index} node={child} />
          ))}
        </div>
      )}
    </div>
  )
}

export function PrimeContext({ agentId }: { agentId: string }) {
  const tree = usePrimeQuery(agentId, 'get_context_tree')
  const prompt = usePrimeQuery(agentId, 'get_system_prompt')
  const systemPrompt = nativeText(nativeRecord(prompt.data).systemPrompt)
  return (
    <div className="space-y-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-fg-3">Context and usage across this session’s agent tree.</p>
        <IconButton
          label="Refresh native context"
          onClick={() => {
            void tree.reload()
            void prompt.reload()
          }}
        >
          <RefreshCw />
        </IconButton>
      </div>
      <PrimeFeedback error={tree.error ?? prompt.error} />
      {tree.loading && tree.data === null ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ContextNode node={nativeRecord(tree.data)} root />
      )}
      <section className="space-y-3 border-t border-hairline-soft pt-5">
        <h3 className="text-sm font-medium text-fg">System prompt</h3>
        {prompt.loading && prompt.data === null && <Skeleton className="h-28 w-full" />}
        {systemPrompt ? (
          <pre
            className={cn(
              'max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-1 p-3',
              'font-mono text-xs leading-relaxed text-fg-2'
            )}
          >
            {systemPrompt}
          </pre>
        ) : (
          !prompt.loading &&
          !prompt.error && (
            <p className="text-sm text-fg-3">The engine returned an empty system prompt.</p>
          )
        )}
      </section>
    </div>
  )
}

export function PrimeSideQuestion({
  agentId,
  initialText
}: {
  agentId: string
  initialText: string
}) {
  const current = useSideQuestions((state) => state.sessions[agentId])
  const [question, setQuestion] = useState(initialText)
  const action = usePrimeAction()
  const running = current?.status === 'running'
  const ask = async () => {
    const accepted = await action.perform(() =>
      useSideQuestions.getState().ask(agentId, question.trim())
    )
    if (accepted) setQuestion('')
  }
  const abort = async () => {
    await action.perform(() => useSideQuestions.getState().abort(agentId))
  }
  return (
    <div className="space-y-5 py-5">
      <p className="text-sm leading-relaxed text-fg-3">
        Ask a side question using the current session context. It has a separate conversation and
        does not interrupt the main task.
      </p>
      <PrimeFeedback error={action.error ?? current?.error} />
      {current?.previousTurns.map((turn, index) => (
        <section key={index} className="space-y-2 border-b border-hairline-soft pb-4">
          <h3 className="text-sm font-medium text-fg">{turn.question}</h3>
          <Markdown text={turn.answer} />
        </section>
      ))}
      {current && (
        <section className="space-y-3 border-b border-hairline-soft pb-5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-fg">{current.question}</h3>
            <Badge>{current.status}</Badge>
          </div>
          {current.answer ? (
            <Markdown text={current.answer} />
          ) : (
            running && <Skeleton className="h-16 w-full" />
          )}
          {running && (
            <Button size="sm" loading={action.pending} onClick={() => void abort()}>
              Stop side question
            </Button>
          )}
        </section>
      )}
      <PrimeFormField label="Question">
        <Textarea
          aria-label="Side question"
          value={question}
          disabled={running}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about the code, a decision, or the current work…"
        />
      </PrimeFormField>
      <Button
        variant="primary"
        loading={action.pending}
        disabled={running || !question.trim()}
        onClick={() => void ask()}
      >
        Ask side question
      </Button>
    </div>
  )
}
