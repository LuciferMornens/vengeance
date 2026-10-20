import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { PrimeAutonomousConfig, PrimeLaunchOptions } from '@shared/api/launch'
import { Button, Input, SegmentedControl, Textarea } from '../../ui'
import { settingsInvokeForFolder } from '../settings/ipc'
import { Group, PathList, Row, TagInput, type TagSuggestion } from './parts'
import type { SectionProps } from './sections'

function updatePrime({ draft, patch }: SectionProps, change: Partial<PrimeLaunchOptions>): void {
  patch({ prime: { ...draft.prime, ...change } })
}

export function PrimeResourcesSection(props: SectionProps) {
  const { cwd, draft } = props
  return (
    <>
      <Group title="Extra skills" description="Skill files or folders loaded for this session.">
        <div className="p-3">
          <PathList
            cwd={cwd}
            values={draft.prime?.skills ?? []}
            onChange={(skills) => updatePrime(props, { skills })}
            placeholder="Skill file or folder"
            filters={[{ name: 'Skills', extensions: ['md'] }]}
          />
        </div>
      </Group>
      <Group
        title="Extra prompt templates"
        description="Template files or folders available as commands."
      >
        <div className="p-3">
          <PathList
            cwd={cwd}
            values={draft.prime?.promptTemplates ?? []}
            onChange={(promptTemplates) => updatePrime(props, { promptTemplates })}
            placeholder="Template file or folder"
            filters={[{ name: 'Templates', extensions: ['md'] }]}
          />
        </div>
      </Group>
    </>
  )
}

export function PrimePromptSection(props: SectionProps) {
  const options = props.draft.prime
  const append = options?.appendSystemPrompt ?? []
  return (
    <>
      <Group
        title="Replace"
        description="Instructions that replace the engine’s default system prompt and any SYSTEM.md."
      >
        <div className="p-3">
          <Textarea
            aria-label="Replacement system prompt"
            value={options?.systemPrompt ?? ''}
            onChange={(event) => updatePrime(props, { systemPrompt: event.target.value })}
            placeholder="Leave empty to keep the default system prompt"
            className="min-h-24 bg-surface-2 font-mono text-xs"
          />
        </div>
      </Group>
      <Group
        title="Append"
        description="Additional instructions, added in order at the end of the system prompt. Any entry here replaces APPEND_SYSTEM.md."
        actions={
          <Button
            size="xs"
            variant="ghost"
            leading={<Plus />}
            onClick={() => updatePrime(props, { appendSystemPrompt: [...append, ''] })}
          >
            Instructions
          </Button>
        }
      >
        {append.length === 0 ? (
          <div className="px-3.5 py-3 text-sm text-fg-3">Nothing appended.</div>
        ) : (
          <div className="space-y-2 p-3">
            {append.map((value, index) => (
              <div key={index} className="flex items-start gap-2">
                <Textarea
                  aria-label={`Appended prompt ${index + 1}`}
                  value={value}
                  onChange={(event) =>
                    updatePrime(props, {
                      appendSystemPrompt: append.map((item, itemIndex) =>
                        itemIndex === index ? event.target.value : item
                      )
                    })
                  }
                  placeholder="Additional instructions"
                  className="min-h-14 flex-1 bg-surface-2 font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove appended prompt ${index + 1}`}
                  onClick={() =>
                    updatePrime(props, {
                      appendSystemPrompt: append.filter((_, itemIndex) => itemIndex !== index)
                    })
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Group>
    </>
  )
}

const MODEL_SUGGESTION_LIMIT = 12

export function PrimeModelsSection(props: SectionProps) {
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  useEffect(() => {
    let active = true
    void settingsInvokeForFolder('prime', props.cwd, 'settings:catalog')
      .then((catalog) => {
        if (!active) return
        setSuggestions(
          catalog.models.slice(0, MODEL_SUGGESTION_LIMIT).map((model) => ({
            value: `${model.provider}/${model.id}`,
            description: model.name
          }))
        )
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [props.cwd])

  return (
    <Group
      title="Model scope"
      description="Models available for startup and cycling. Use provider/model references or wildcard patterns."
    >
      <div className="p-3">
        <TagInput
          aria-label="Model scope"
          values={props.draft.prime?.models ?? []}
          onChange={(models) => updatePrime(props, { models })}
          placeholder="provider/model or provider/*"
          suggestions={suggestions}
        />
      </div>
    </Group>
  )
}

type AutonomousLimit =
  'maxContinuations' | 'maxTurns' | 'maxTokens' | 'timeoutMs' | 'subagentKeepAliveMs'

const AUTONOMOUS_LIMITS: Array<{ key: AutonomousLimit; label: string; unit?: string }> = [
  { key: 'maxContinuations', label: 'Continuation limit' },
  { key: 'maxTurns', label: 'Turn limit' },
  { key: 'maxTokens', label: 'Token limit', unit: 'tokens' },
  { key: 'timeoutMs', label: 'Time limit', unit: 'ms' },
  { key: 'subagentKeepAliveMs', label: 'Keep subagents alive', unit: 'ms' }
]

function NumberOverride({
  label,
  value,
  unit,
  onChange
}: {
  label: string
  value: number | undefined
  unit?: string
  onChange(value: number | undefined): void
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        inputSize="sm"
        type="number"
        min={0}
        step={1}
        aria-label={label}
        value={value ?? ''}
        placeholder="Default"
        onChange={(event) => {
          const next = event.target.valueAsNumber
          onChange(Number.isSafeInteger(next) && next >= 0 ? next : undefined)
        }}
        className="w-28 tabular-nums"
      />
      {unit && <span className="w-10 text-xs text-fg-3">{unit}</span>}
    </div>
  )
}

export function PrimeAutonomousSection(props: SectionProps) {
  const options = props.draft.prime?.autonomous ?? {}
  const patch = (change: Partial<PrimeAutonomousConfig>) =>
    updatePrime(props, {
      autonomous: { ...options, ...change }
    })
  const enabled = options.enabled === undefined ? 'default' : options.enabled ? 'on' : 'off'

  return (
    <>
      <Group>
        <Row
          label="Autonomous execution"
          description="Continue working within these limits until the task is complete."
        >
          <SegmentedControl
            aria-label="Autonomous execution"
            size="sm"
            value={enabled}
            segments={[
              { value: 'default', label: 'Default' },
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' }
            ]}
            onValueChange={(value) =>
              patch({ enabled: value === 'default' ? undefined : value === 'on' })
            }
          />
        </Row>
      </Group>
      <Group
        title="Execution limits"
        description="Leave a limit blank to use the engine’s default."
      >
        {AUTONOMOUS_LIMITS.map(({ key, label, unit }) => (
          <Row key={key} label={label}>
            <NumberOverride
              label={label}
              value={options[key]}
              unit={unit}
              onChange={(value) => patch({ [key]: value })}
            />
          </Row>
        ))}
      </Group>
      <Group
        title="Continuation prompt"
        description="Instructions used when autonomous execution continues."
      >
        <div className="p-3">
          <Textarea
            aria-label="Continuation prompt"
            value={options.continuationPrompt ?? ''}
            onChange={(event) => patch({ continuationPrompt: event.target.value })}
            placeholder="Use the engine’s continuation instructions"
            className="min-h-20 bg-surface-2 font-mono text-xs"
          />
        </div>
      </Group>
      <Group
        title="Completion checks"
        description="Shell commands checked before the engine finishes, one per line."
      >
        <div className="p-3">
          <Textarea
            aria-label="Completion check commands"
            value={(options.gates?.commands ?? []).join('\n')}
            onChange={(event) =>
              patch({
                gates: { ...options.gates, commands: event.target.value.split('\n') }
              })
            }
            placeholder="Commands to check the result"
            className="min-h-20 bg-surface-2 font-mono text-xs"
          />
        </div>
        <Row label="Retries after a failed check">
          <NumberOverride
            label="Completion check retries"
            value={options.gates?.maxRetries}
            onChange={(maxRetries) => patch({ gates: { ...options.gates, maxRetries } })}
          />
        </Row>
        <Row label="Check time limit">
          <NumberOverride
            label="Completion check time limit"
            value={options.gates?.timeoutMs}
            unit="ms"
            onChange={(timeoutMs) => patch({ gates: { ...options.gates, timeoutMs } })}
          />
        </Row>
      </Group>
    </>
  )
}
