import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ResourceGroup, ResourceItem } from '@shared/api/settings'
import { Badge, Button, SegmentedControl, Skeleton, Switch } from '../../ui'
import { settingsInvokeForFolder } from '../settings/ipc'
import { Group, Note, Row, SearchQueryContext } from '../settings/layout'
import { activeCwd, useSettings } from '../settings/store'
import { PrimeSettingField } from './prime-fields'
import { PRIME_SETTINGS_GROUPS, type PrimeSettingsSection } from './prime-schema'

export function PrimeSettingsGroups({ section }: { section: PrimeSettingsSection }) {
  const groups = PRIME_SETTINGS_GROUPS.filter((group) => group.section === section)
  return (
    <>
      {groups.map((group) => (
        <Group key={group.title} title={group.title}>
          {group.fields.map((field) => (
            <PrimeSettingField key={field.key} field={field} />
          ))}
        </Group>
      ))}
    </>
  )
}

function matchingPrimeSettings(query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return PRIME_SETTINGS_GROUPS.map((group) => ({
    ...group,
    fields: group.fields.filter((field) => {
      const searchable =
        `${field.key} ${field.label} ${field.description ?? ''} ${group.title}`.toLowerCase()
      return terms.every((term) => searchable.includes(term))
    })
  })).filter((group) => group.fields.length > 0)
}

export function primeSettingsMatchCount(query: string): number {
  return matchingPrimeSettings(query).reduce((total, group) => total + group.fields.length, 0)
}

export function PrimeSettingsSearch({ query }: { query: string }) {
  const groups = matchingPrimeSettings(query)
  return (
    <SearchQueryContext.Provider value={query}>
      {groups.map((group) => (
        <Group key={`${group.section}:${group.title}`} title={group.title}>
          {group.fields.map((field) => (
            <PrimeSettingField key={field.key} field={field} />
          ))}
        </Group>
      ))}
    </SearchQueryContext.Provider>
  )
}

type ResourceFilter = 'all' | 'skills' | 'prompts' | 'themes'

export function PrimeResourcesSection() {
  const snapshot = useSettings((state) => state.snapshot)
  const [groups, setGroups] = useState<ResourceGroup[] | null>(null)
  const [filter, setFilter] = useState<ResourceFilter>('all')
  const [error, setError] = useState<string | null>(null)
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const workspace = snapshot?.project?.cwd ?? activeCwd()
  const reload = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      setGroups(await settingsInvokeForFolder('prime', workspace, 'settings:resources', workspace))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshing(false)
    }
  }, [workspace])

  useEffect(() => {
    void reload()
  }, [reload, snapshot])

  const toggle = async (item: ResourceItem, enabled: boolean) => {
    setPendingPath(item.path)
    setError(null)
    try {
      setGroups(
        await settingsInvokeForFolder('prime', workspace, 'settings:resource-toggle', {
          cwd: workspace,
          item,
          enabled
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPendingPath(null)
    }
  }

  const visibleGroups = useMemo(
    () =>
      (groups ?? [])
        .map((group) => ({
          ...group,
          items: group.items.filter(
            (item) => item.type !== 'extensions' && (filter === 'all' || item.type === filter)
          )
        }))
        .filter((group) => group.items.length > 0),
    [groups, filter]
  )

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<ResourceFilter>
          value={filter}
          onValueChange={setFilter}
          segments={[
            { value: 'all', label: 'All resources' },
            { value: 'skills', label: 'Skills' },
            { value: 'prompts', label: 'Prompts' },
            { value: 'themes', label: 'Themes' }
          ]}
        />
        <Button
          size="sm"
          leading={<RefreshCw />}
          loading={refreshing}
          onClick={() => void reload()}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {!groups && !error && <Skeleton className="mb-7 h-24 w-full rounded-card" />}
      {groups && visibleGroups.length === 0 && (
        <Group title="Installed resources">
          <Note>
            Install a package or add a resource path below to make it available to Engine 2.
          </Note>
        </Group>
      )}
      {visibleGroups.map((group) => (
        <Group key={group.key} title={group.label}>
          {group.items.map((item) => (
            <Row
              key={`${item.type}:${item.path}`}
              label={item.displayName}
              description={item.description ?? item.path}
              badges={
                <Badge>
                  {item.type === 'prompts' ? 'Prompt' : item.type === 'skills' ? 'Skill' : 'Theme'}
                </Badge>
              }
            >
              <Switch
                aria-label={`Enable ${item.displayName}`}
                checked={item.enabled}
                disabled={pendingPath !== null}
                onCheckedChange={(enabled) => void toggle(item, enabled)}
              />
            </Row>
          ))}
        </Group>
      ))}
      <PrimeSettingsGroups section="resources" />
    </>
  )
}
