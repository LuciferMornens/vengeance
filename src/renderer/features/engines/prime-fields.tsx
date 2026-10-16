import type { JsonValue } from '@shared/api/settings'
import { Badge, Select } from '../../ui'
import { ListEditor, NumberField, TextField } from '../settings/controls'
import { Row } from '../settings/layout'
import { useResolved, useSettings } from '../settings/store'
import type { PrimeFieldDefinition } from './prime-schema'

const DEFAULT_CHOICE = '__engine_default__'
const CUSTOM_LIMIT = '__custom_limit__'
const GLOBAL_ONLY_KEYS = new Set([
  'allowedModels',
  'updateChannel',
  'rlmMaxDepth',
  'idleEvictionMinutes',
  'sessionArchiveMaxAgeDays',
  'sessionArchiveMaxSessions',
  'telemetry.noticeShown'
])
const TERMINAL_ONLY_KEYS = new Set([
  'theme',
  'chatDetail',
  'treeFilterMode',
  'editorPaddingX',
  'autocompleteMaxVisible',
  'showHardwareCursor',
  'quietStartup',
  'onboardingShown',
  'onboardingCompleted'
])

interface PrimeLimitFieldProps {
  label: string
  value: number | 'off' | 'none' | 'unlimited' | undefined
  special: 'off' | 'unlimited'
  unit?: 'ms' | 'tokens'
  disabled?: boolean
  onChange: (value: number | 'off' | 'unlimited' | undefined) => void
}

export function PrimeLimitField({
  label,
  value,
  special,
  unit,
  disabled,
  onChange
}: PrimeLimitFieldProps) {
  const selected = typeof value === 'number' ? CUSTOM_LIMIT : value === 'none' ? 'off' : value
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {typeof value === 'number' && (
        <NumberField
          aria-label={label}
          value={value}
          min={special === 'unlimited' ? 1 : 0}
          integer
          unit={unit}
          disabled={disabled}
          onCommit={onChange}
        />
      )}
      <Select
        value={selected ?? DEFAULT_CHOICE}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === DEFAULT_CHOICE) onChange(undefined)
          else if (next === CUSTOM_LIMIT) onChange(1)
          else onChange(special)
        }}
        options={[
          { value: DEFAULT_CHOICE, label: 'Engine default' },
          { value: CUSTOM_LIMIT, label: 'Custom limit' },
          { value: special, label: special === 'off' ? 'Disabled' : 'Unlimited' }
        ]}
      />
    </div>
  )
}

function limitValue(value: JsonValue | undefined): PrimeLimitFieldProps['value'] {
  return typeof value === 'number' || value === 'off' || value === 'none' || value === 'unlimited'
    ? value
    : undefined
}

function PrimeFieldControl({
  field,
  value,
  disabled,
  onChange
}: {
  field: PrimeFieldDefinition
  value: JsonValue | undefined
  disabled: boolean
  onChange: (next: JsonValue | undefined) => void
}) {
  const { control } = field
  if (control.kind === 'boolean') {
    return (
      <Select
        value={typeof value === 'boolean' ? String(value) : DEFAULT_CHOICE}
        disabled={disabled}
        onValueChange={(next) => onChange(next === DEFAULT_CHOICE ? undefined : next === 'true')}
        options={[
          { value: DEFAULT_CHOICE, label: 'Engine default' },
          { value: 'true', label: 'On' },
          { value: 'false', label: 'Off' }
        ]}
      />
    )
  }
  if (control.kind === 'number') {
    return (
      <NumberField
        aria-label={field.label}
        value={typeof value === 'number' ? value : undefined}
        placeholder="Default"
        min={control.minimum}
        max={Number.MAX_SAFE_INTEGER}
        integer
        unit={control.unit}
        disabled={disabled}
        onCommit={onChange}
      />
    )
  }
  if (control.kind === 'limit') {
    return (
      <PrimeLimitField
        label={field.label}
        value={limitValue(value)}
        special={control.special}
        unit={control.unit}
        disabled={disabled}
        onChange={onChange}
      />
    )
  }
  if (control.kind === 'choice') {
    const options = [...control.options]
    if (typeof value === 'string' && !options.some((option) => option.value === value)) {
      options.push({ value, label: value })
    }
    return (
      <Select
        value={typeof value === 'string' ? value : DEFAULT_CHOICE}
        disabled={disabled}
        options={[{ value: DEFAULT_CHOICE, label: 'Engine default' }, ...options]}
        onValueChange={(next) => onChange(next === DEFAULT_CHOICE ? undefined : next)}
      />
    )
  }
  if (control.kind === 'list') {
    return (
      <ListEditor
        value={
          Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : []
        }
        disabled={disabled}
        unique={!control.ordered}
        placeholder={control.placeholder ?? 'Add an entry…'}
        onChange={onChange}
      />
    )
  }
  return (
    <TextField
      value={typeof value === 'string' ? value : undefined}
      disabled={disabled}
      browse={control.browse}
      placeholder={control.placeholder ?? 'Engine default'}
      keepEmpty={field.key === 'markdown.codeBlockIndent'}
      onCommit={onChange}
    />
  )
}

export function PrimeSettingField({ field }: { field: PrimeFieldDefinition }) {
  const resolved = useResolved(field.key)
  const scope = useSettings((state) => state.scope)
  const setSetting = useSettings((state) => state.set)
  const override = useSettings((state) => state.snapshot?.envOverrides[field.key])
  const globalOnlyHere = scope === 'project' && GLOBAL_ONLY_KEYS.has(field.key)
  const disabled = !!override || globalOnlyHere
  const terminalOnly =
    TERMINAL_ONLY_KEYS.has(field.key) ||
    field.key.startsWith('terminal.') ||
    field.key.startsWith('markdown.')
  const effect = terminalOnly ? 'none' : undefined
  const value = globalOnlyHere ? resolved.globalValue : resolved.value
  const control = (
    <PrimeFieldControl
      field={field}
      value={override?.value ?? value}
      disabled={disabled}
      onChange={(next) => void setSetting(field.key, next, undefined, effect)}
    />
  )
  const fullWidth = field.control.kind === 'text' || field.control.kind === 'list'
  return (
    <Row
      settingKey={field.key}
      label={field.label}
      description={override ? `Set by ${override.variable}.` : field.description}
      badges={
        <>
          {globalOnlyHere && <Badge>Global only</Badge>}
          {scope === 'project' && !resolved.setHere && resolved.globalValue !== undefined && (
            <Badge>Inherited</Badge>
          )}
          {scope === 'project' && resolved.setHere && <Badge>Project</Badge>}
          {scope === 'global' && resolved.projectValue !== undefined && (
            <Badge>Overridden in project</Badge>
          )}
        </>
      }
      onReset={
        resolved.setHere && !disabled
          ? () => void setSetting(field.key, undefined, undefined, effect)
          : undefined
      }
      resetLabel={scope === 'project' ? 'Remove project override' : 'Reset to engine default'}
      below={fullWidth ? control : undefined}
    >
      {fullWidth ? undefined : control}
    </Row>
  )
}
