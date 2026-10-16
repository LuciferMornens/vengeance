import { SPEED_MODES, type SpeedMode } from '@shared/api/speed'
import { useApp } from '../../../store/app'
import { Badge, Select } from '../../../ui'
import { SPEED_LABELS, speedDescription } from '../../composer/speed'
import { Row } from '../layout'

const DESCRIPTION =
  'Fast and Ultrafast cost more and apply only to models that offer them. ' +
  'Choosing a speed in a session also changes this.'

/**
 * The Engine's response speed for sessions without a saved choice (a Vengeance pref, read by main
 * when it starts an engine as `SPEED_DEFAULT_ENV`). Choosing a speed in a session also updates it.
 */
export function SpeedDefaultRow() {
  const settingsPrefs = useApp((s) => s.prefs.features.settings)
  const updateFeature = useApp((s) => s.updateFeaturePrefs)
  return (
    <Row
      settingKey="app.speedDefault"
      label="Response speed for new sessions"
      description={DESCRIPTION}
      badges={<Badge>Vengeance</Badge>}
    >
      <Select
        className="min-w-[160px]"
        aria-label="Response speed for new sessions"
        value={settingsPrefs?.speedDefault ?? 'standard'}
        onValueChange={(speedDefault: SpeedMode) =>
          updateFeature('settings', { ...settingsPrefs, speedDefault })
        }
        options={SPEED_MODES.map((mode) => ({
          value: mode,
          label: SPEED_LABELS[mode],
          description: speedDescription(mode)
        }))}
      />
    </Row>
  )
}
