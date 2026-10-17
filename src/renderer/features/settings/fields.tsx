import { useEffect, useState, type ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import type { JsonValue, SettingEnvOverride } from '@shared/api/settings'
import {
  findSetting,
  SETTINGS,
  type ChoiceOption,
  type SettingControl,
  type SettingDef,
  type SettingsSectionId
} from '@shared/api/settings-schema'
import { invoke, on } from './ipc'
import { platform } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { Badge, Switch, Tooltip } from '../../ui'
import { AutoNumberField, ChoiceField, ListEditor, NumberField, TextField } from './controls'
import {
  CompactionOverridesEditor,
  DefaultModelEditor,
  DefaultToolsEditor,
  EnabledModelsEditor,
  ModelThinkingLevelsEditor
} from './editors'
import { Group, KeyHint, Row } from './layout'
import { activeCwd, useResolved, useSettings, type ResolvedSetting } from './store'
import { settingEffect } from './values'

/** Schema-driven rows: every engine setting renders through SettingField. */

function formatValue(value: JsonValue | undefined): string {
  if (value === undefined) return 'unset'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function ScopeBadges({ def, resolved }: { def: SettingDef; resolved: ResolvedSetting }) {
  const scope = useSettings((s) => s.scope)
  const hasProject = useSettings((s) => !!s.snapshot?.project)
  const badges: ReactNode[] = []
  if (def.globalOnly && scope === 'project')
    badges.push(
      <Badge key="g" tone="warning">
        Global only
      </Badge>
    )
  if (scope === 'global' && hasProject && resolved.projectValue !== undefined && !def.globalOnly) {
    badges.push(
      <Tooltip key="o" content={`Project value: ${formatValue(resolved.projectValue)}`}>
        <span>
          <Badge>Overridden in project</Badge>
        </span>
      </Tooltip>
    )
  }
  if (scope === 'project' && !def.globalOnly) {
    if (resolved.setHere) badges.push(<Badge key="p">Project</Badge>)
    else if (resolved.globalValue !== undefined) badges.push(<Badge key="i">Inherited</Badge>)
  }
  if ((def.gui || def.alsoInSessions) && def.section === 'terminal') {
    badges.push(
      <Tooltip
        key="v"
        content={
          def.gui
            ? 'Vengeance honors this setting too'
            : 'Sessions in Vengeance use it too; open ones after a restart'
        }
      >
        <span>
          <Badge>Also in Vengeance</Badge>
        </span>
      </Tooltip>
    )
  }
  return <>{badges}</>
}

/** Why a field is locked: the environment beats settings.json in every session. The variable name is a detail. */
function EnvOverrideNote({ override }: { override: SettingEnvOverride }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      Sessions use the value below and ignore this setting while the variable is set.{' '}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-fg-2 underline-offset-2 hover:text-fg hover:underline"
      >
        {open ? 'Hide details' : 'Details'}
      </button>
      {open && (
        <span className="mt-1 block">
          Variable <KeyHint>{override.variable}</KeyHint>
        </span>
      )}
    </>
  )
}

/** Custom theme names the engine loads for the active folder, refreshed when resources may have changed. */
function useInstalledThemes(enabled: boolean): string[] {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    if (!enabled) return
    const load = () =>
      void invoke('settings:themes', activeCwd()).then(setNames, () => setNames([]))
    load()
    return on(
      'settings:changed',
      ({ area }) =>
        (area === 'resources' || area === 'packages' || area === 'settings' || area === 'trust') &&
        load()
    )
  }, [enabled])
  return names
}

function ChoiceControl({
  def,
  control,
  value,
  disabled
}: {
  def: SettingDef
  control: Extract<SettingControl, { kind: 'choice' }>
  value: JsonValue | undefined
  disabled: boolean
}) {
  const set = useSettings((s) => s.set)
  const themes = useInstalledThemes(!!control.installedThemes)
  const builtIn = new Set(control.options.map((option) => option.value))
  const options: ChoiceOption[] = [
    ...control.options,
    ...themes.filter((name) => !builtIn.has(name)).map((name) => ({ value: name, label: name }))
  ]
  return (
    <ChoiceField
      value={value ?? def.default ?? undefined}
      options={options}
      segmented={control.segmented}
      disabled={disabled}
      onChange={(v) => void set(def.key, v)}
    />
  )
}

/** The engine's built-in thinking budgets (pi-ai `DEFAULT_THINKING_BUDGETS`), which the schema only labels "Built-in". */
const THINKING_BUDGET_DEFAULTS: Record<string, number> = {
  'thinkingBudgets.minimal': 1024,
  'thinkingBudgets.low': 2048,
  'thinkingBudgets.medium': 8192,
  'thinkingBudgets.high': 16384
}

/** Number placeholder: the inherited value in project scope, else the real default (blank when it has none). */
function usePlaceholder(
  def: SettingDef,
  resolved: ResolvedSetting,
  scope: string
): string | number | undefined {
  // A default that names another setting ("HTTP idle timeout") shows that setting's current value.
  const linked = SETTINGS.find((s) => s.label === def.defaultLabel && s.control.kind === 'number')
  const linkedValue = useResolved(linked?.key ?? def.key).value
  if (scope === 'project' && typeof resolved.globalValue === 'number') return resolved.globalValue
  if (typeof def.default === 'number') return def.default
  if (def.key in THINKING_BUDGET_DEFAULTS) return THINKING_BUDGET_DEFAULTS[def.key]
  if (linked)
    return typeof linkedValue === 'number'
      ? linkedValue
      : typeof linked.default === 'number'
        ? linked.default
        : undefined
  return def.defaultLabel && def.defaultLabel.length <= 12 ? def.defaultLabel : undefined
}

/** One section-level line instead of a "Requires restart" badge on every row; shown while sessions are open. */
function RestartNote({ defs }: { defs: SettingDef[] }) {
  const hasAgents = useAgents((s) => s.order.length > 0)
  // A terminal setting sessions also read says so in its own badge; the rest of that section needs no restart.
  if (
    !hasAgents ||
    !defs.some((d) => !d.live && !d.alsoInSessions && settingEffect(d) === 'restart')
  )
    return null
  return (
    <p className="mb-4 flex items-center gap-2 px-1 text-sm text-fg-3">
      <RotateCw className="size-3.5 shrink-0" />
      Open sessions pick up changes here after an engine restart.
    </p>
  )
}

function Control({
  def,
  resolved,
  disabled
}: {
  def: SettingDef
  resolved: ResolvedSetting
  disabled: boolean
}) {
  const set = useSettings((s) => s.set)
  const scope = useSettings((s) => s.scope)
  const placeholder = usePlaceholder(def, resolved, scope)
  const { control } = def
  const value = resolved.value
  switch (control.kind) {
    case 'switch':
      return (
        <Switch
          aria-label={def.label}
          checked={typeof value === 'boolean' ? value : def.default === true}
          disabled={disabled}
          onCheckedChange={(checked) => void set(def.key, checked)}
        />
      )
    case 'choice':
      return <ChoiceControl def={def} control={control} value={value} disabled={disabled} />
    case 'number':
      return (
        <NumberField
          aria-label={def.label}
          value={resolved.setHere && typeof value === 'number' ? value : undefined}
          placeholder={placeholder}
          min={control.min}
          max={control.max}
          integer={control.integer}
          unit={control.unit}
          disabled={disabled}
          onCommit={(v) => void set(def.key, v)}
        />
      )
    case 'auto-number':
      return (
        <AutoNumberField
          value={value}
          min={control.min}
          max={control.max}
          disabled={disabled}
          onChange={(v) => void set(def.key, v)}
        />
      )
    case 'text':
      return null
    case 'list':
      return null
    case 'custom':
      return null
  }
}

function Below({
  def,
  resolved,
  disabled
}: {
  def: SettingDef
  resolved: ResolvedSetting
  disabled: boolean
}) {
  const set = useSettings((s) => s.set)
  const { control } = def
  if (control.kind === 'text') {
    return (
      <TextField
        value={typeof resolved.value === 'string' ? resolved.value : undefined}
        placeholder={
          control.placeholderByOs?.[platform.os] ?? control.placeholder ?? def.defaultLabel
        }
        mono={control.mono}
        browse={control.path}
        disabled={disabled}
        keepEmpty={def.default === '  '}
        onCommit={(v) => void set(def.key, v)}
      />
    )
  }
  if (control.kind === 'list') {
    const list = Array.isArray(resolved.value)
      ? resolved.value.filter((v): v is string => typeof v === 'string')
      : []
    return (
      <ListEditor
        value={list}
        mono={control.mono}
        placeholder={control.placeholder}
        disabled={disabled}
        onChange={(next) => void set(def.key, next.length ? next : undefined)}
      />
    )
  }
  if (control.kind === 'custom') {
    switch (control.editor) {
      case 'default-model':
        return <DefaultModelEditor disabled={disabled} />
      case 'model-thinking-levels':
        return <ModelThinkingLevelsEditor resolved={resolved} disabled={disabled} />
      case 'enabled-models':
        return <EnabledModelsEditor resolved={resolved} disabled={disabled} />
      case 'default-tools':
        return <DefaultToolsEditor resolved={resolved} disabled={disabled} />
      case 'compaction-overrides':
        return <CompactionOverridesEditor resolved={resolved} disabled={disabled} />
      case 'packages':
        return null
    }
  }
  return null
}

export function SettingField({ def }: { def: SettingDef }) {
  const fileValue = useResolved(def.key)
  const scope = useSettings((s) => s.scope)
  const set = useSettings((s) => s.set)
  const envOverride = useSettings((s) => s.snapshot?.envOverrides[def.key])
  const globalOnlyHere = !!def.globalOnly && scope === 'project'
  const disabled = globalOnlyHere || !!envOverride
  // While the environment overrides it, the field shows the value sessions really use.
  const resolved = envOverride ? { ...fileValue, value: envOverride.value } : fileValue
  const inline =
    def.control.kind === 'switch' ||
    def.control.kind === 'choice' ||
    def.control.kind === 'number' ||
    def.control.kind === 'auto-number'
  const reset = () => {
    void set(def.key, undefined)
    for (const key of def.alsoKeys ?? []) void set(key, undefined)
  }
  return (
    <Row
      settingKey={def.key}
      label={def.label}
      description={envOverride ? <EnvOverrideNote override={envOverride} /> : def.description}
      badges={
        <>
          <ScopeBadges def={def} resolved={resolved} />
          {envOverride && <Badge tone="info">Set by an environment variable</Badge>}
        </>
      }
      onReset={resolved.setHere && !disabled ? reset : undefined}
      resetLabel={scope === 'project' ? 'Remove project override' : 'Reset to default'}
      below={inline ? undefined : <Below def={def} resolved={resolved} disabled={disabled} />}
      dimmed={globalOnlyHere}
    >
      {inline ? <Control def={def} resolved={resolved} disabled={disabled} /> : undefined}
    </Row>
  )
}

/** All schema settings of a section, grouped into cards in schema order. `extras` appends non-Engine rows to a group. */
export function SchemaGroups({
  section,
  only,
  exclude,
  extras
}: {
  section: SettingsSectionId
  only?: string[]
  exclude?: string[]
  extras?: Partial<Record<string, ReactNode>>
}) {
  const defs = SETTINGS.filter(
    (s) => s.section === section && (!only || only.includes(s.group)) && !exclude?.includes(s.group)
  )
  const groups = [...new Set(defs.map((d) => d.group))]
  return (
    <>
      <RestartNote defs={defs} />
      {groups.map((group) => (
        <Group key={group} title={group}>
          {defs
            .filter((d) => d.group === group)
            .map((def) => (
              <SettingField key={def.key} def={def} />
            ))}
          {extras?.[group]}
        </Group>
      ))}
    </>
  )
}

export function FieldByKey({ settingKey }: { settingKey: string }) {
  const def = findSetting(settingKey)
  return def ? <SettingField def={def} /> : null
}
