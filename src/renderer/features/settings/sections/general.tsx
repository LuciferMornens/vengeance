import { Check, Monitor, Moon, Sun } from 'lucide-react'
import type { AccentName, Density, ThemePref } from '@shared/api/app'
import type { ReducedMotionPref, RestartPolicy } from '@shared/api/settings'
import { DEFAULT_UPDATE_INTERVAL_HOURS, type AutoUpdateMode } from '@shared/api/updates'
import { cn } from '../../../lib/cn'
import { platform } from '../../../lib/ipc'
import { SYSTEM_NAME, systemSetting } from '../../../lib/platform-copy'
import { useApp } from '../../../store/app'
import { Button, SegmentedControl, Select, Slider } from '../../../ui'
import { openAbout } from '../../about'
import { TextField } from '../controls'
import { Group, Row } from '../layout'

/** App-level preferences (stored in Vengeance's own app state, not engine settings). */

export const ACCENTS: { value: AccentName; label: string; from: string; to: string }[] = [
  { value: 'ember', label: 'Ember', from: '#ff4d3d', to: '#ff8a3d' },
  { value: 'violet', label: 'Violet', from: '#8b5cf6', to: '#c084fc' },
  { value: 'cyan', label: 'Cyan', from: '#06b6d4', to: '#5eead4' },
  { value: 'lime', label: 'Lime', from: '#84cc16', to: '#d9f99d' },
  { value: 'rose', label: 'Rose', from: '#f43f5e', to: '#fb7185' },
  { value: 'mono', label: 'Mono', from: '#d4d4dc', to: '#8e8e9a' }
]

const THEMES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'dark', label: 'Obsidian', icon: Moon },
  { value: 'light', label: 'Bone', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor }
]

/** Miniature window preview for the theme cards. */
function ThemePreview({ variant }: { variant: 'dark' | 'light' | 'split' }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex h-full flex-1 gap-1 p-1.5', dark ? 'bg-[#0b0b0e]' : 'bg-[#f4f2ee]')}>
      <div className={cn('w-1/4 rounded-xs', dark ? 'bg-[#16161d]' : 'bg-[#ffffff]')} />
      <div className="flex flex-1 flex-col gap-1">
        <div className={cn('h-1.5 w-3/4 rounded-full', dark ? 'bg-[#2a2a33]' : 'bg-[#dcd8d0]')} />
        <div className={cn('h-1.5 w-1/2 rounded-full', dark ? 'bg-[#2a2a33]' : 'bg-[#dcd8d0]')} />
        <div className="mt-auto h-2.5 rounded-xs bg-accent-gradient opacity-90" />
      </div>
    </div>
  )
  return (
    <div className="flex h-[72px] overflow-hidden rounded-md shadow-[0_0_0_1px_var(--hairline-strong)]">
      {variant === 'split' ? (
        <>
          {pane(false)}
          {pane(true)}
        </>
      ) : (
        pane(variant === 'dark')
      )}
    </div>
  )
}

export function GeneralSection() {
  const prefs = useApp((s) => s.prefs)
  const update = useApp((s) => s.update)
  const updateFeature = useApp((s) => s.updateFeaturePrefs)
  const settingsPrefs = prefs.features.settings ?? {}
  const updatesPrefs = prefs.features.updates ?? {}

  return (
    <>
      <Group title="Appearance">
        <Row
          settingKey="app.theme"
          label="Theme"
          description={`Obsidian is the hero; Bone is a warm light theme. System follows ${SYSTEM_NAME}.`}
        >
          {undefined}
        </Row>
        <div className="-mt-1 grid grid-cols-3 gap-3 border-b border-hairline-soft px-4 pb-4">
          {THEMES.map((t) => {
            const active = prefs.theme === t.value
            const Icon = t.icon
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => update({ theme: t.value })}
                className={cn(
                  'group/theme rounded-card p-1.5 text-left transition-[box-shadow,background-color] duration-[var(--dur-fast)]',
                  active
                    ? 'bg-active shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--fg)_70%,transparent)]'
                    : 'shadow-[0_0_0_1px_var(--hairline)] hover:bg-hover'
                )}
              >
                <ThemePreview variant={t.value === 'system' ? 'split' : t.value} />
                <div className="mt-2 flex items-center gap-1.5 px-1 pb-0.5 text-sm font-medium text-fg-2">
                  <Icon className="size-3.5 text-fg-3" />
                  <span className="flex-1">{t.label}</span>
                  {active && <Check className="size-3.5 text-fg" />}
                </div>
              </button>
            )
          })}
        </div>
        <Row
          settingKey="app.accent"
          label="Accent"
          description="Used sparingly: send, selection and the streaming glow."
        >
          <div className="flex items-center gap-2.5">
            {ACCENTS.map((a) => (
              <button
                key={a.value}
                type="button"
                aria-label={a.label}
                title={a.label}
                onClick={() => update({ accent: a.value })}
                className={cn(
                  'relative size-[22px] rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18),0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-[var(--dur-fast)] hover:scale-110',
                  prefs.accent === a.value &&
                    'scale-110 ring-2 ring-fg/80 ring-offset-2 ring-offset-surface-2'
                )}
                style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}
              />
            ))}
          </div>
        </Row>
        <Row
          settingKey="app.fontScale"
          label="Text size"
          description="Scales the interface and transcript."
        >
          <div className="flex w-[220px] items-center gap-3">
            <span className="text-xs text-fg-3">A</span>
            <Slider
              min={0.85}
              max={1.25}
              step={0.05}
              value={prefs.fontScale}
              onValueChange={(fontScale) => update({ fontScale })}
              aria-label="Text size"
            />
            <span className="text-md text-fg-3">A</span>
            <span className="tabular w-10 text-right text-sm text-fg-2">
              {Math.round(prefs.fontScale * 100)}%
            </span>
          </div>
        </Row>
        <Row
          settingKey="app.density"
          label="Density"
          description="Compact tightens rows and controls."
        >
          <SegmentedControl<Density>
            value={prefs.density}
            onValueChange={(density) => update({ density })}
            segments={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' }
            ]}
          />
        </Row>
        <Row
          settingKey="app.motion"
          label="Motion"
          description={`Reduced turns springs and transitions into simple fades. System follows ${systemSetting('animation')}.`}
        >
          <SegmentedControl<ReducedMotionPref>
            value={settingsPrefs.motion ?? 'system'}
            onValueChange={(motion) => updateFeature('settings', { ...settingsPrefs, motion })}
            segments={[
              { value: 'system', label: 'System' },
              { value: 'reduce', label: 'Reduced' }
            ]}
          />
        </Row>
      </Group>

      <Group title="App behavior">
        <Row
          settingKey="app.restartPolicy"
          label="Apply engine changes"
          description="Most engine settings take effect when a session’s engine restarts. Running agents always finish first."
        >
          <SegmentedControl<RestartPolicy>
            value={settingsPrefs.restartPolicy ?? 'ask'}
            onValueChange={(restartPolicy) =>
              updateFeature('settings', { ...settingsPrefs, restartPolicy })
            }
            segments={[
              { value: 'ask', label: 'Ask' },
              { value: 'always', label: 'Restart' },
              { value: 'never', label: 'Later' }
            ]}
          />
        </Row>
        <Row
          settingKey="app.updates"
          label="Updates"
          description="Notify shows a titlebar pill. Automatic updates the engine and packages while agents are idle."
        >
          <SegmentedControl<AutoUpdateMode>
            value={updatesPrefs.mode ?? 'notify'}
            onValueChange={(mode) => updateFeature('updates', { ...updatesPrefs, mode })}
            segments={[
              { value: 'off', label: 'Off' },
              { value: 'notify', label: 'Notify' },
              { value: 'automatic', label: 'Automatic' }
            ]}
          />
        </Row>
        <Row
          settingKey="app.updateInterval"
          label="Check for updates"
          description="Also checks on launch. Skipped while offline."
          dimmed={updatesPrefs.mode === 'off'}
        >
          <Select
            className="min-w-[160px]"
            value={String(updatesPrefs.intervalHours ?? DEFAULT_UPDATE_INTERVAL_HOURS)}
            onValueChange={(v) =>
              updateFeature('updates', { ...updatesPrefs, intervalHours: Number(v) })
            }
            options={[
              { value: '1', label: 'Every hour' },
              { value: '6', label: 'Every 6 hours' },
              { value: '12', label: 'Every 12 hours' },
              { value: '24', label: 'Daily' }
            ]}
          />
        </Row>
        <Row
          settingKey="app.feedUrl"
          label="Vengeance update feed"
          description="Generic update server for Vengeance itself. Leave empty to disable app self-updates."
          below={
            <TextField
              mono
              value={updatesPrefs.feedUrl}
              placeholder="https://updates.example.com/vengeance"
              onCommit={(feedUrl) => updateFeature('updates', { ...updatesPrefs, feedUrl })}
            />
          }
        />
      </Group>

      <Group title="About">
        <Row
          settingKey="app.about"
          label="Vengeance"
          description={<span className="tabular">Version {platform.appVersion}</span>}
        >
          <Button variant="secondary" size="sm" onClick={openAbout}>
            About Vengeance
          </Button>
        </Row>
      </Group>
    </>
  )
}
