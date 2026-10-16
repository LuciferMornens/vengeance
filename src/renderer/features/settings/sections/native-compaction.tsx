import { useApp } from '../../../store/app'
import { Badge, Switch } from '../../../ui'
import { Row } from '../layout'

/**
 * Compaction row for Vengeance's OpenAI native compaction (a Vengeance pref, not an Engine setting): read by
 * main when it starts an engine (`VENGEANCE_NATIVE_COMPACTION`), so it applies to sessions started or restarted after
 * the change.
 */
export function NativeCompactionRow() {
  const settingsPrefs = useApp((s) => s.prefs.features.settings)
  const updateFeature = useApp((s) => s.updateFeaturePrefs)
  const enabled = settingsPrefs?.nativeCompaction !== false
  return (
    <Row
      settingKey="app.nativeCompaction"
      label="OpenAI native compaction"
      description="With an OpenAI model, OpenAI compacts the context itself and keeps more of the work than a summary. The summary is still written for other models. Applies to sessions started after the change."
      badges={<Badge>Vengeance</Badge>}
    >
      <Switch
        checked={enabled}
        onCheckedChange={(nativeCompaction) =>
          updateFeature('settings', { ...settingsPrefs, nativeCompaction })
        }
        aria-label="OpenAI native compaction"
      />
    </Row>
  )
}
