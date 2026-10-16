import { useEffect, useState } from 'react'

/** Titles longer than this are cut at a word boundary. */
const MAX_TITLE = 80
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

/** A role head this short (`Lane A`) takes its parenthetical as a subtitle: `Lane A · transcript + tool cards`. */
const MAX_WORDS_FOR_SUBTITLE = 2
/** A first sentence this short (`You are a worker.`) names the role, not the task; the next sentence is used. */
const MAX_ROLE_SENTENCE_WORDS = 3

/** Session name the subagents extension gives a child: `subagent-worker-<run uuid>-1`. */
const CHILD_SESSION_NAME = /^subagent-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i
/** The `Task:` label orchestrators put before a brief. */
const TASK_LABEL = /^task:\s*/i
/** Brief prefixes that describe the reader, not the task: `You are the`, `READ-ONLY`. */
const ROLE_PREAMBLE = /^(you are\s+(the\s+|a\s+|an\s+)?|read-only\s+)/i
/** A brief that names a lane or wave is a role description even without a preamble. */
const ROLE_HEAD = /^(lane|wave)\b/i
/** Where a role head ends: `LANE A (…)`, `GATE for "Vengeance"`, `LANE A of Wave 2`, `Fix:`, `Lane B — …`. */
const ROLE_HEAD_END = [' (', ' for ', ' of ', ':', ' —', '—', ', ']
/** An all-caps word: letters, hyphens and slashes, at least two letters. */
const CAPS_WORD = /^[A-Z][A-Z/-]*[A-Z]$/
/** Shortest all-caps word lowered in a role head; shorter ones (`UI`, `A`) stay as written. */
const MIN_LOWERED_CAPS = 3
/** Shortest part of a hyphenated caps word that reads as a word (`READ-ONLY`), not a lane id (`F-CORE`). */
const MIN_WORD_PART = 3

/** The agent role in an extension-generated child session name (`worker`), else undefined. */
export function childSessionAgent(sessionName: string | undefined): string | undefined {
  return sessionName ? CHILD_SESSION_NAME.exec(sessionName.trim())?.[1] : undefined
}

function stripPreamble(text: string): { text: string; stripped: boolean } {
  let rest = text
  let match = ROLE_PREAMBLE.exec(rest)
  while (match) {
    rest = rest.slice(match[0].length)
    match = ROLE_PREAMBLE.exec(rest)
  }
  return { text: rest, stripped: rest !== text }
}

function firstSentence(text: string): string {
  const sentence = /^[^\n]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text.split('\n')[0]!
  return sentence.replace(/[.!?]$/, '').trim()
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Shouting text starts with two all-caps words: `FINAL POLISH LANE F-CORE`. */
function isShouting(text: string): boolean {
  const [first, second] = text.split(/\s+/)
  return !!first && !!second && CAPS_WORD.test(first) && CAPS_WORD.test(second)
}

/** `READ-ONLY` → `read-only`; short acronyms (`UX`) and lane ids (`F-CORE`) stay as written. */
function lowerCapsSegment(segment: string): string {
  if (!CAPS_WORD.test(segment) || segment.length < MIN_LOWERED_CAPS) return segment
  return segment.split('-').every((part) => part.length >= MIN_WORD_PART) ? segment.toLowerCase() : segment
}

/** Lower shouted words: `FINAL POLISH LANE F-CORE` → `final polish lane F-CORE`, `VISUAL/UX` → `visual/UX`. */
function lowerShouting(text: string): string {
  return text
    .split(' ')
    .map((word) => word.split('/').map(lowerCapsSegment).join('/'))
    .join(' ')
}

/** Lower title-cased words of a subtitle, keeping acronyms: `Transcript + Tool cards` → `transcript + tool cards`. */
function lowerTitleCase(text: string): string {
  return text.replace(/\b[A-Z][a-z]+\b/g, (word) => word.toLowerCase())
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The head of a role brief (`Final polish lane F-CORE`), with a short head's parenthetical as subtitle. */
function roleTitle(text: string): string {
  const ends = ROLE_HEAD_END.map((marker) => text.indexOf(marker)).filter((index) => index > 0)
  const end = ends.length > 0 ? Math.min(...ends) : text.length
  const head = text.slice(0, end).trim()
  let title = capitalize(lowerShouting(head))
  const subtitle = text.startsWith(' (', end) ? /^ \(([^)]+)\)/.exec(text.slice(end))?.[1]?.trim() : undefined
  if (subtitle && wordCount(head) <= MAX_WORDS_FOR_SUBTITLE) title = `${title} · ${lowerTitleCase(subtitle)}`
  return title
}

function clampTitle(title: string): string {
  if (title.length <= MAX_TITLE) return title
  const cut = title.slice(0, MAX_TITLE)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_TITLE / 2))}…`
}

/**
 * A run's title: the child session name when the user gave one, else the task's first sentence. Role briefs lose
 * their preamble and trailing context (`You are FINAL POLISH LANE F-CORE (main…) for …` → `Final polish lane F-CORE`).
 */
export function runTitle(sessionName: string | undefined, task: string | undefined): string | undefined {
  const name = sessionName?.trim()
  if (name && !childSessionAgent(name)) return name
  const { text, stripped } = stripPreamble(task?.trim().replace(TASK_LABEL, '') ?? '')
  if (!text) return undefined
  const sentence = firstSentence(text)
  const rest = text.slice(text.indexOf(sentence) + sentence.length).replace(/^[.!?]?\s*/, '')
  if (stripped && wordCount(sentence) <= MAX_ROLE_SENTENCE_WORDS && rest) return runTitle(undefined, rest)
  const roleBrief = stripped || ROLE_HEAD.test(text) || isShouting(text)
  return clampTitle(roleBrief ? roleTitle(sentence) : sentence)
}

/** The trailer pi-subagents appends to a saved final output: `Output saved to: <path> (20.8 KB, 220 lines). Read this file if needed.` */
const OUTPUT_SAVED = /\n*Output saved to: ([^\n]+?)(?: \([^)\n]*\))?\.?(?: Read this file if needed\.)?\s*$/

/** A final output without the `Output saved to:` trailer, plus the saved file's path from it. */
export function splitSavedOutput(output: string): { text: string; path?: string } {
  const match = OUTPUT_SAVED.exec(output)
  if (!match) return { text: output }
  return { text: output.slice(0, match.index).trimEnd(), path: match[1]!.trim() }
}

/** Launch `model` arg without the provider, thinking level after a dot: `claude-opus-5-5 · high`. */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined
  const [id, thinking] = model.replace(/^[^/]+\//, '').split(':')
  return thinking ? `${id} · ${thinking}` : id
}

/** A ticking clock: `0:41`, `12:04`, `1:02:03`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / SECONDS_PER_HOUR)
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = String(total % SECONDS_PER_MINUTE).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Current time, re-read every `intervalMs` while `active` (live elapsed clocks). */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
