import { Check, MessageCircleQuestion } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { useAgents } from '../../../store/agents'
import { Badge, Shimmer } from '../../../ui'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { RowDetail, ToolRow } from '../ToolRow'
import { bool, isRecord, num, payloadText, records, resultPayload, str, strings, toolPhase } from '../tool-utils'

interface Question {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

interface Answer {
  questionIndex: number
  kind: string
  answer: string | null
  selected: string[]
  notes?: string
}

function questionsOf(args: Record<string, unknown>): Question[] {
  const list: Question[] = records(args.questions).map((q) => ({
    question: str(q.question) ?? '',
    header: str(q.header),
    options: records(q.options).map((o) => ({ label: str(o.label) ?? '', description: str(o.description) })),
    multiSelect: bool(q.multiSelect) ?? false
  }))
  // Single-question shapes used by other ask tools.
  if (list.length === 0 && typeof args.question === 'string') {
    const options = Array.isArray(args.options) ? args.options.map((o) => (typeof o === 'string' ? { label: o } : { label: str(isRecord(o) ? o.label : '') ?? '' })) : []
    list.push({ question: args.question, header: undefined, options, multiSelect: false })
  }
  return list
}

function answersOf(details: unknown): { answers: Answer[]; cancelled: boolean } {
  if (!isRecord(details)) return { answers: [], cancelled: false }
  const answers = records(details.answers).map((a, i) => ({
    questionIndex: num(a.questionIndex) ?? i,
    kind: str(a.kind) ?? 'option',
    answer: str(a.answer) ?? null,
    selected: strings(a.selected),
    notes: str(a.notes)
  }))
  return { answers, cancelled: bool(details.cancelled) ?? false }
}

/** Fallback: `"Question"="Answer"` pairs from the tool's text envelope. */
function answersFromText(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of text.matchAll(/"([^"]+)"="([^"]*)"/g)) map.set(m[1]!, m[2]!)
  return map
}

/** The options a question's answer picked (structured answer, else the text envelope). */
function chosenFor(question: Question, answer: Answer | undefined, textAnswers: Map<string, string>): Set<string> {
  if (answer) return new Set(answer.selected.length ? answer.selected : answer.answer ? [answer.answer] : [])
  const fromText = textAnswers.get(question.question)
  return new Set(fromText ? [fromText] : [])
}

function QuestionList({ questions, answers, textAnswers }: { questions: Question[]; answers: Answer[]; textAnswers: Map<string, string> }) {
  return (
    <div className="flex flex-col gap-4 px-3.5 py-3">
      {questions.map((q, qi) => {
        const answer = answers.find((a) => a.questionIndex === qi)
        const chosen = chosenFor(q, answer, textAnswers)
        const custom = answer?.kind === 'custom' || (chosen.size > 0 && ![...chosen].some((c) => q.options.some((o) => o.label === c)))
        return (
          <div key={qi}>
            <div className="mb-2 flex items-start gap-2">
              {q.header && <Badge className="mt-px shrink-0">{q.header}</Badge>}
              <div className="text-ui leading-snug font-medium text-fg">{q.question}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => {
                const picked = chosen.has(o.label)
                return (
                  <span
                    key={o.label}
                    title={o.description}
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm transition-colors',
                      picked ? 'bg-accent-soft text-accent-text shadow-[inset_0_0_0_1px_var(--accent-border)]' : 'text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)]',
                      chosen.size > 0 && !picked && 'opacity-60'
                    )}
                  >
                    {picked && <Check className="size-3.5" strokeWidth={2.5} />}
                    {o.label}
                  </span>
                )
              })}
              {custom &&
                [...chosen].map((c) => (
                  <span key={c} className="inline-flex h-7 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-sm text-accent-text">
                    <Check className="size-3.5" strokeWidth={2.5} />“{c}”
                  </span>
                ))}
            </div>
            {answer?.notes && <div className="mt-2 text-sm text-fg-2 italic">“{answer.notes}”</div>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Questions to the user. While the question is open it stays a card (it needs the user); once answered it
 * settles into a row whose meta carries the answer, with every question and pick one click away.
 */
function AskUserRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const payload = resultPayload(execution)
  const questions = questionsOf(call.arguments)
  const { answers, cancelled } = answersOf(payload?.details)
  const textAnswers = answersFromText(payloadText(payload))
  const waiting = phase === 'running' || phase === 'pending'
  const declined = cancelled || /declined/i.test(payloadText(payload))
  const first = questions[0]
  const firstAnswer = first ? [...chosenFor(first, answers.find((a) => a.questionIndex === 0), textAnswers)].join(', ') : ''

  if (waiting) {
    return (
      <div data-ask-user-card className="overflow-hidden rounded-card bg-surface-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
        <div className="flex h-8 items-center gap-2 border-b border-hairline-soft px-3.5 text-xs">
          <MessageCircleQuestion className="size-3.5 text-fg-3" />
          <span className="font-medium text-fg-2">{questions.length > 1 ? `${questions.length} questions for you` : 'A question for you'}</span>
          <Shimmer className="ml-auto">Waiting for you</Shimmer>
        </div>
        <QuestionList questions={questions} answers={answers} textAnswers={textAnswers} />
      </div>
    )
  }

  return (
    <ToolRow
      verb="Asked"
      subject={<span className="min-w-0 truncate">{first?.header ?? first?.question ?? 'A question'}</span>}
      meta={
        declined && phase === 'done' ? (
          <Badge>Declined</Badge>
        ) : firstAnswer ? (
          <span className="max-w-[220px] truncate text-fg-2">{firstAnswer}</span>
        ) : questions.length > 1 ? (
          <span>{questions.length} questions</span>
        ) : null
      }
      phase={phase}
      durationMs={execution?.durationMs}
      detail={
        questions.length > 0 ? (
          <RowDetail>
            <QuestionList questions={questions} answers={answers} textAnswers={textAnswers} />
          </RowDetail>
        ) : undefined
      }
    />
  )
}

registerToolRenderer(['ask_user_question', 'ask_user', 'AskUserQuestion', 'question'], AskUserRow)
