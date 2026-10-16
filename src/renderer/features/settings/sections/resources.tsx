import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Command, Palette, Puzzle } from 'lucide-react'
import type { ResourceGroup, ResourceItem, ResourceType } from '@shared/api/settings'
import { invoke, on } from '../ipc'
import { Badge, SegmentedControl, Skeleton, Switch, toast, Tooltip } from '../../../ui'
import { SchemaGroups } from '../fields'
import { Group, Note, UntrustedProjectCallout } from '../layout'
import { activeCwd } from '../store'

/** Every extension, skill, prompt template and theme the engine loads, with per-item toggles. */

const TYPE_META: Record<ResourceType, { label: string; icon: typeof Puzzle }> = {
  extensions: { label: 'Extension', icon: Puzzle },
  skills: { label: 'Skill', icon: BookOpen },
  prompts: { label: 'Prompt', icon: Command },
  themes: { label: 'Theme', icon: Palette }
}

type Filter = 'all' | ResourceType

function ResourceRow({
  item,
  onToggle
}: {
  item: ResourceItem
  onToggle: (enabled: boolean) => void
}) {
  const { icon: Icon, label } = TYPE_META[item.type]
  return (
    <div
      id={`setting-resource.${item.displayName}`}
      className="group/row flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
    >
      <Tooltip content={label}>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-fg-3 shadow-[0_0_0_1px_var(--hairline)]">
          <Icon className="size-3.5" />
        </span>
      </Tooltip>
      <div className={`min-w-0 flex-1 ${item.enabled ? '' : 'opacity-55'}`}>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-ui font-medium text-fg">
            {item.type === 'prompts'
              ? `/${item.displayName}`
              : item.type === 'skills'
                ? `/skill:${item.displayName}`
                : item.displayName}
          </span>
        </div>
        {item.description && (
          <div className="line-clamp-1 text-sm text-fg-3">{item.description}</div>
        )}
      </div>
      <Switch
        aria-label={`Enable ${item.displayName}`}
        checked={item.enabled}
        onCheckedChange={onToggle}
      />
    </div>
  )
}

export function ResourcesSection() {
  const [groups, setGroups] = useState<ResourceGroup[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const reload = useCallback(
    async () => setGroups(await invoke('settings:resources', activeCwd())),
    []
  )
  useEffect(() => {
    void reload()
    return on('settings:changed', ({ area }) => {
      if (area === 'packages' || area === 'settings' || area === 'trust') void reload()
    })
  }, [reload])

  const toggle = async (item: ResourceItem, enabled: boolean) => {
    setGroups(
      (current) =>
        current?.map((g) => ({
          ...g,
          items: g.items.map((i) =>
            i.path === item.path && i.type === item.type ? { ...i, enabled } : i
          )
        })) ?? null
    )
    try {
      setGroups(await invoke('settings:resource-toggle', { cwd: activeCwd(), item, enabled }))
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not change resource',
        description: (error as Error).message
      })
      void reload()
    }
  }

  const counts = useMemo(() => {
    const all = (groups ?? []).flatMap((g) => g.items)
    const of = (type: ResourceType) => all.filter((i) => i.type === type).length
    return {
      all: all.length,
      extensions: of('extensions'),
      skills: of('skills'),
      prompts: of('prompts'),
      themes: of('themes')
    }
  }, [groups])
  const visible = (groups ?? [])
    .map((g) => ({ ...g, items: g.items.filter((i) => filter === 'all' || i.type === filter) }))
    .filter((g) => g.items.length > 0)

  return (
    <>
      <UntrustedProjectCallout items="extensions, skills, prompts and themes" />
      <div className="mb-5">
        <SegmentedControl<Filter>
          value={filter}
          onValueChange={setFilter}
          segments={[
            { value: 'all', label: `All ${counts.all}` },
            { value: 'extensions', label: `Extensions ${counts.extensions}` },
            { value: 'skills', label: `Skills ${counts.skills}` },
            { value: 'prompts', label: `Prompts ${counts.prompts}` },
            { value: 'themes', label: `Themes ${counts.themes}` }
          ]}
        />
      </div>
      {!groups && (
        <Group>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
            >
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-3.5 w-48" />
            </div>
          ))}
        </Group>
      )}
      {groups && visible.length === 0 && (
        <Group>
          <Note>Nothing here yet. Install a package or add paths below.</Note>
        </Group>
      )}
      {visible.map((group) => (
        <Group
          key={group.key}
          title={
            <span className="flex items-center gap-2">
              {group.label}
              <span className="font-normal text-fg-3">{group.items.length}</span>
              {group.scope === 'project' && <Badge>Project</Badge>}
            </span>
          }
        >
          {group.items.map((item) => (
            <ResourceRow
              key={`${item.type}:${item.path}`}
              item={item}
              onToggle={(enabled) => void toggle(item, enabled)}
            />
          ))}
        </Group>
      ))}
      <SchemaGroups section="resources" />
    </>
  )
}
