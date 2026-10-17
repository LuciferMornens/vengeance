/**
 * Primitives gallery (dev/test only): every token and primitive in one scrollable page so the system can be
 * inspected in both themes and all accents. Mounted by main.tsx at `#design`; screenshotted by scripts/shots/design.mjs.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Bell, Copy, FileCode2, FolderOpen, GitFork, Search, Settings, Sparkles, SquarePen, Trash2, TriangleAlert } from 'lucide-react'
import type { AccentName } from '@shared/api/app'
import { cn } from '../../lib/cn'
import { shortcutText } from '../../lib/keybindings'
import { REVEAL_LABEL, TRASH_NAME } from '../../lib/platform-copy'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  Kbd,
  ListRow,
  Mark,
  Pill,
  SegmentedControl,
  Select,
  Shimmer,
  Skeleton,
  Slider,
  Spinner,
  Switch,
  Tabs,
  Textarea,
  toast,
  floatingSurface,
  type DialogSize,
  type Tone
} from '..'

const ACCENTS: AccentName[] = ['ember', 'violet', 'cyan', 'lime', 'rose', 'mono']
const TONES: Tone[] = ['neutral', 'accent', 'info', 'success', 'warning', 'danger']

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('flex flex-col gap-4 p-5', className)}>
      <h2 className="text-xs font-medium text-fg-3">{title}</h2>
      {children}
    </Card>
  )
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn('h-10 rounded-md shadow-[inset_0_0_0_1px_var(--hairline)]', className)} />
      <span className="font-mono text-2xs text-fg-3">{name}</span>
    </div>
  )
}

function AccentCell({ accent }: { accent: AccentName }) {
  const [on, setOn] = useState(true)
  return (
    <div data-accent={accent} className="flex flex-col gap-2.5 rounded-card bg-surface-1 p-3 shadow-elev-0">
      <div className="flex items-center gap-2">
        <span className="relative flex size-2">
          <span className="absolute inset-[-3px] animate-[v-pulse_1.6s_ease-in-out_infinite] rounded-full bg-accent-soft" />
          <span className="relative size-2 rounded-full bg-accent" />
        </span>
        <span className="text-sm font-medium text-fg capitalize">{accent}</span>
      </div>
      <Button variant="primary" size="sm">
        Send
      </Button>
      <div className="flex items-center justify-between">
        <Switch checked={on} onCheckedChange={setOn} aria-label={`${accent} switch`} />
        <Badge tone="accent">New</Badge>
      </div>
      <span className="text-sm text-accent-text">Accent text</span>
    </div>
  )
}

function DialogDemo({ size, onOpen }: { size: DialogSize; onOpen: (size: DialogSize) => void }) {
  return (
    <Button size="sm" variant="secondary" onClick={() => onOpen(size)}>
      {size}
    </Button>
  )
}

export function DesignGallery() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'))
  const [accent, setAccent] = useState<AccentName>(() => (document.documentElement.dataset.accent as AccentName | undefined) ?? 'ember')
  const [dialog, setDialog] = useState<DialogSize | null>(null)
  const [segment, setSegment] = useState<'all' | 'ext' | 'skills'>('all')
  const [tab, setTab] = useState('overview')
  const [tab2, setTab2] = useState('diff')
  const [checked, setChecked] = useState(true)
  const [slider, setSlider] = useState(62)
  const [model, setModel] = useState<string>('sonnet')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  return (
    <div data-gallery className="h-full overflow-y-auto">
      <header className="drag sticky top-0 z-10 flex h-[var(--titlebar-h)] items-center gap-3 border-b border-hairline-soft bg-[var(--glass-strong)] pr-[calc(var(--titlebar-inset-end)+12px)] pl-[max(16px,var(--titlebar-inset-start))] backdrop-blur-xl">
        <Mark size={16} />
        <span className="text-sm font-medium text-fg">Design system</span>
        <span className="text-sm text-fg-3">Obsidian &amp; Ember</span>
        <span className="flex-1" />
        <SegmentedControl
          size="sm"
          value={theme}
          onValueChange={setTheme}
          segments={[
            { value: 'dark', label: 'Obsidian' },
            { value: 'light', label: 'Bone' }
          ]}
        />
        <SegmentedControl size="sm" value={accent} onValueChange={setAccent} segments={ACCENTS.map((a) => ({ value: a, label: a[0]!.toUpperCase() + a.slice(1) }))} />
      </header>

      <div className="mx-auto grid max-w-[1360px] grid-cols-12 gap-4 p-5">
        <Section title="Surfaces & text" className="col-span-5">
          <div className="grid grid-cols-6 gap-2">
            <Swatch name="bg" className="bg-bg" />
            <Swatch name="surface-1" className="bg-surface-1" />
            <Swatch name="surface-2" className="bg-surface-2" />
            <Swatch name="surface-3" className="bg-surface-3" />
            <Swatch name="surface-4" className="bg-surface-4" />
            <Swatch name="glass" className="bg-glass" />
          </div>
          <div className="flex items-baseline gap-4">
            <span className="text-ui text-fg">Primary fg</span>
            <span className="text-ui text-fg-2">Secondary fg-2</span>
            <span className="text-ui text-fg-3">Tertiary fg-3</span>
            <span className="text-ui text-fg-4">Disabled fg-4</span>
          </div>
          <div className="grid grid-cols-5 gap-2">
            <Swatch name="accent" className="bg-accent" />
            <Swatch name="accent-2" className="bg-accent-2" />
            <Swatch name="accent-soft" className="bg-accent-soft" />
            <Swatch name="danger" className="bg-danger" />
            <Swatch name="danger-soft" className="bg-danger-soft" />
            <Swatch name="success" className="bg-success" />
            <Swatch name="warning" className="bg-warning" />
            <Swatch name="info" className="bg-info" />
            <Swatch name="control-on" className="bg-control-on" />
            <Swatch name="pill" className="bg-pill" />
          </div>
        </Section>

        <Section title="Type scale" className="col-span-7">
          <div className="flex flex-col gap-1.5">
            <span className="heading text-2xl text-fg">Vengeance, quietly dangerous</span>
            <span className="heading text-xl text-fg">Session title 21</span>
            <span className="heading text-lg text-fg">Section heading 17</span>
            <span className="heading text-title text-fg">Dialog title 15 / 600</span>
            <span className="text-prose text-fg">Transcript prose 15 — generous line-height for reading long answers.</span>
            <span className="text-ui text-fg-2">UI 13.5 — the default for controls, rows and labels.</span>
            <span className="text-sm text-fg-3">Small 12.5 — descriptions, metadata, hints.</span>
            <span className="tabular font-mono text-sm text-fg-2">Mono 12.5 · src/session/store.ts · 1,284 tokens · $0.06</span>
          </div>
        </Section>

        <Section title="Accents (scoped data-accent)" className="col-span-12">
          <div className="grid grid-cols-6 gap-3">
            {ACCENTS.map((a) => (
              <AccentCell key={a} accent={a} />
            ))}
          </div>
        </Section>

        <Section title="Buttons" className="col-span-7">
          {(['primary', 'secondary', 'outline', 'ghost', 'danger'] as const).map((variant) => (
            <Row key={variant}>
              <span className="w-20 text-xs text-fg-3 capitalize">{variant}</span>
              <Button variant={variant} size="xs">
                Extra small
              </Button>
              <Button variant={variant} size="sm" leading={<SquarePen />}>
                Small
              </Button>
              <Button variant={variant}>Medium</Button>
              <Button variant={variant} size="lg">
                Large
              </Button>
              <Button variant={variant} disabled>
                Disabled
              </Button>
              <Button variant={variant} loading>
                Loading
              </Button>
            </Row>
          ))}
          <Row>
            <span className="w-20 text-xs text-fg-3">Icon</span>
            <IconButton label="New session" hotkey="mod+n">
              <SquarePen />
            </IconButton>
            <IconButton label="Fork" variant="secondary">
              <GitFork />
            </IconButton>
            <IconButton label="Pressed" active>
              <Settings />
            </IconButton>
            <IconButton label="Delete" variant="danger">
              <Trash2 />
            </IconButton>
            <IconButton label="Disabled" disabled>
              <Copy />
            </IconButton>
          </Row>
        </Section>

        <Section title="Badges · chips · pills · keys" className="col-span-5">
          <Row>
            {TONES.map((tone) => (
              <Badge key={tone} tone={tone}>
                {tone === 'neutral' ? '12' : tone[0]!.toUpperCase() + tone.slice(1)}
              </Badge>
            ))}
            <Badge tone="success" dot>
              Live
            </Badge>
          </Row>
          <Row>
            {TONES.map((tone) => (
              <Chip key={tone} tone={tone} icon={<FileCode2 />}>
                {tone}
              </Chip>
            ))}
            <Chip mono onRemove={() => undefined}>
              src/app.ts
            </Chip>
          </Row>
          <Row>
            <Pill indicator="live" onClick={() => undefined}>
              2 working
            </Pill>
            <Pill tone="warning" indicator="dot" onClick={() => undefined}>
              1 session needs input
            </Pill>
            <Pill indicator="dot" onClick={() => undefined}>
              4 updates
            </Pill>
            <Pill indicator="spinner">Updating…</Pill>
          </Row>
          <Row>
            <Kbd combo="mod+k" />
            <Kbd combo="mod+shift+p" />
            <Kbd combo="alt+enter" size="xs" />
            <span className="flex items-center gap-2">
              <Avatar name="aurora" />
              <Avatar name="vengeance" />
              <Avatar name="pi-lens" />
            </span>
          </Row>
        </Section>

        <Section title="Fields & controls" className="col-span-7">
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder="Plain input" />
            <Input leading={<Search />} placeholder="Search sessions" trailing={<Kbd combo="mod+f" size="xs" />} />
            <Input defaultValue="sk-invalid" aria-invalid />
            <Input placeholder="Disabled" disabled />
            <Select
              value={model}
              onValueChange={setModel}
              options={[
                { value: 'sonnet', label: 'Claude Sonnet 4.5' },
                { value: 'opus', label: 'Claude Opus 4.1', description: 'Most capable' },
                { value: 'gpt', label: 'GPT-5' }
              ]}
            />
            <Select value={undefined} onValueChange={() => undefined} placeholder="Choose a provider" options={[{ value: 'a', label: 'Anthropic' }]} />
            <Textarea className="col-span-2 min-h-16" placeholder={`Steer the agent — or ${shortcutText('alt+enter')} to queue a follow-up`} />
          </div>
          <Row className="gap-5">
            <Switch checked={checked} onCheckedChange={setChecked} aria-label="Switch" />
            <Switch checked={!checked} onCheckedChange={(v) => setChecked(!v)} aria-label="Switch off" />
            <Switch checked size="sm" onCheckedChange={() => undefined} aria-label="Small switch" />
            <Switch checked disabled onCheckedChange={() => undefined} aria-label="Disabled switch" />
            <Checkbox checked={checked} onCheckedChange={setChecked} aria-label="Checkbox" />
            <Checkbox checked="indeterminate" onCheckedChange={() => undefined} aria-label="Indeterminate" />
            <Checkbox checked={false} onCheckedChange={() => undefined} aria-label="Unchecked" />
            <Slider value={slider} onValueChange={setSlider} className="w-40" aria-label="Slider" />
          </Row>
          <Row className="gap-4">
            <SegmentedControl
              value={segment}
              onValueChange={setSegment}
              segments={[
                { value: 'all', label: 'All 18' },
                { value: 'ext', label: 'Extensions 8' },
                { value: 'skills', label: 'Skills 5' }
              ]}
            />
            <Tabs
              variant="segmented"
              value={tab2}
              onValueChange={setTab2}
              items={[
                { value: 'diff', label: 'Diff', content: null },
                { value: 'file', label: 'File', content: null }
              ]}
            />
          </Row>
          <Tabs
            value={tab}
            onValueChange={setTab}
            listClassName="px-0"
            items={[
              { value: 'overview', label: 'Overview', content: null },
              { value: 'branches', label: 'Branches', content: null },
              { value: 'files', label: 'Files', content: null },
              { value: 'timeline', label: 'Timeline', content: null }
            ]}
          />
        </Section>

        <Section title="List rows (menu · list · rich)" className="col-span-5">
          <div className={cn(floatingSurface, 'relative z-0 w-full')}>
            <ListRow density="menu" icon={<GitFork />} title="Fork from here" trailing={<Kbd combo="mod+shift+f" size="xs" />} />
            <ListRow density="menu" icon={<FolderOpen />} title={REVEAL_LABEL} data-highlighted="" />
            <ListRow density="menu" icon={<Trash2 />} title="Delete session" danger />
          </div>
          <div className="flex flex-col gap-0.5">
            <ListRow icon={<Sparkles />} title="Explain this codebase" meta="⏎" />
            <ListRow icon={<Bell />} title="Debounced persist race" meta="38m" selected />
            <ListRow icon={<FileCode2 />} title="Disabled row" disabled />
          </div>
          <div className="flex flex-col gap-0.5">
            <ListRow density="rich" iconTile icon={<Sparkles />} title="Claude Sonnet 4.5" subtitle="anthropic · 200k context · $3 / $15" trailing={<Badge>Default</Badge>} selected />
            <ListRow density="rich" iconTile icon={<Sparkles />} title="GPT-5" subtitle="openai · 400k context · $1.25 / $10" meta="Thinking" />
          </div>
        </Section>

        <Section title="Feedback & overlays" className="col-span-7">
          <Row>
            <span className="w-20 text-xs text-fg-3">Dialogs</span>
            {(['confirm', 'form', 'picker', 'editor'] as const).map((size) => (
              <DialogDemo key={size} size={size} onOpen={setDialog} />
            ))}
          </Row>
          <Row>
            <span className="w-20 text-xs text-fg-3">Toasts</span>
            <Button size="sm" onClick={() => toast({ level: 'success', title: 'Session exported', description: 'Saved to Downloads/aurora.html', action: { label: REVEAL_LABEL, onClick: () => undefined } })}>
              Success
            </Button>
            <Button size="sm" onClick={() => toast({ level: 'info', title: 'Answer recorded: No, just SessionStore' })}>
              Info
            </Button>
            <Button size="sm" onClick={() => toast({ level: 'warning', title: 'Engine restart required', description: 'Two settings take effect after the next restart.' })}>
              Warning
            </Button>
            <Button size="sm" onClick={() => toast({ level: 'error', title: 'Could not start the engine', description: 'node exited with code 1' })}>
              Error
            </Button>
          </Row>
          <div className="grid grid-cols-3 gap-3">
            <Card variant="flat" className="flex flex-col gap-2 p-3">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
            </Card>
            <Card variant="inset" className="flex items-center gap-2 p-3 text-sm">
              <Spinner className="text-fg-3" />
              <Shimmer>Thinking…</Shimmer>
            </Card>
            <Card interactive className="flex items-center gap-2 p-3 text-sm text-fg-2">
              <TriangleAlert className="size-4 text-warning" />
              Interactive card
            </Card>
          </div>
        </Section>

        <Section title="Empty state" className="col-span-5">
          <EmptyState
            className="py-4"
            icon={<FolderOpen />}
            title="No sessions yet"
            description="Start a session to see it here."
            action={
              <Button variant="primary" size="sm" leading={<SquarePen />}>
                New session
              </Button>
            }
          />
        </Section>
      </div>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        size={dialog ?? 'form'}
        icon={dialog === 'confirm' ? <Trash2 /> : <GitFork />}
        iconTone={dialog === 'confirm' ? 'danger' : 'neutral'}
        title={dialog === 'confirm' ? 'Delete this session?' : 'Fork from a message'}
        description={dialog === 'confirm' ? `The session file moves to the ${TRASH_NAME}. Open agents keep running.` : 'Pick the message to branch from. The original session stays untouched.'}
        hint={dialog === 'confirm' ? undefined : { combo: 'enter', label: 'to fork' }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant={dialog === 'confirm' ? 'danger' : 'primary'} onClick={() => setDialog(null)}>
              {dialog === 'confirm' ? 'Delete' : 'Fork'}
            </Button>
          </>
        }
      >
        {dialog !== 'confirm' && (
          <div className="flex flex-col gap-0.5">
            <ListRow icon={<Sparkles />} title="Can you also add a regression test?" meta="2m" selected />
            <ListRow icon={<Sparkles />} title="Why does the dev server restart twice?" meta="14m" />
            <ListRow icon={<Sparkles />} title="Profile the startup path" meta="1h" />
          </div>
        )}
      </Dialog>
    </div>
  )
}
