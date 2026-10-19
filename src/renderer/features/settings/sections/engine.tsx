import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Cpu,
  DatabaseZap,
  FolderOpen,
  Info,
  RotateCcw,
  ScrollText
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ENGINE_LABELS, type EngineId, type EngineLocationInfo } from '@shared/api/engine'
import { cn } from '../../../lib/cn'
import { basename } from '../../../lib/format'
import { invoke } from '../ipc'
import { useAgents } from '../../../store/agents'
import { useApp } from '../../../store/app'
import { Badge, Button, Select, Skeleton, Switch, toast } from '../../../ui'
import { agentOwnTitle } from '../../sessions/model'
import { openChangelog } from '../../updates/changelog'
import { useUpdates } from '../../updates/store'
import { useEngineRegistry } from '../../engines/registry'
import { PrimeSettingsGroups } from '../../engines/prime-settings'
import { TextField } from '../controls'
import { restartEngines } from '../engines'
import { Callout, Group, Row } from '../layout'
import { useSettings } from '../store'

/** Detected engine, location override, update status, diagnostics and config folder. */

const SOURCE_LABEL: Record<NonNullable<EngineLocationInfo['source']>, string> = {
  bundled: 'Included with Vengeance',
  override: 'Custom location',
  path: 'PATH',
  managed: 'Managed install',
  'npm-global': 'npm global'
}

function Diagnostics({ engine }: { engine: EngineId }) {
  const entries = useAgents(
    useShallow((s) => {
      const out: string[] = []
      for (const id of s.order) {
        const agent = s.agents[id]
        if (agent && agent.info.engine === engine) {
          out.push(`${agent.id}\n${agentOwnTitle(agent) || basename(agent.info.cwd)}`)
        }
      }
      return out
    })
  )
  const agents = useMemo(
    () =>
      entries.map((entry) => {
        const i = entry.indexOf('\n')
        return { id: entry.slice(0, i), label: entry.slice(i + 1) }
      }),
    [entries]
  )
  const [agentId, setAgentId] = useState<string | undefined>(agents[0]?.id)
  const [log, setLog] = useState<string | null>(null)
  useEffect(() => {
    if (!agents.some((agent) => agent.id === agentId)) setAgentId(agents[0]?.id)
  }, [agentId, agents])
  useEffect(() => {
    setLog(null)
    if (!agentId) return
    let active = true
    void invoke('engine:stderr', agentId).then((text) => {
      if (active) setLog(text)
    })
    return () => {
      active = false
    }
  }, [agentId])
  if (agents.length === 0)
    return (
      <Row
        label="Diagnostics"
        description="Engine error output appears here once a session is running."
      />
    )
  return (
    <Row
      label="Diagnostics"
      description="Recent error output (stderr) from a session’s engine process."
      below={
        <pre className="selectable max-h-48 overflow-auto rounded-md bg-surface-1 p-3 font-mono text-xs leading-[18px] whitespace-pre-wrap text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
          {log === null ? 'Loading…' : log.trim() || 'No error output. All quiet.'}
        </pre>
      }
    >
      <Select
        size="sm"
        aria-label="Diagnostics session"
        className="w-[220px]"
        value={agentId}
        onValueChange={setAgentId}
        options={agents.map((a) => ({
          value: a.id,
          label: a.label
        }))}
      />
    </Row>
  )
}

export function EngineSection() {
  const engine = useSettings((state) => state.engine)
  const label = ENGINE_LABELS[engine]
  const [info, setInfo] = useState<EngineLocationInfo | null>(null)
  const override = useApp((state) =>
    engine === 'pi' ? state.prefs.engineOverridePath : state.prefs.engineOverridePaths?.[engine]
  )
  const update = useApp((s) => s.update)
  const snapshot = useSettings((s) => s.snapshot)
  const updates = useUpdates((state) => state.states[engine] ?? null)
  const runUpdate = useUpdates((s) => s.run)
  const offline = useApp((s) => !!s.prefs.features.updates?.offline)
  const setOffline = useUpdates((s) => s.setOffline)
  const busy = !!updates?.running
  const detectionRequest = useRef(0)
  const detectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openUpdates = () => {
    void useUpdates.getState().setEngine(engine)
    useUpdates.getState().setSheetOpen(true)
  }
  const check = async () => {
    await useUpdates.getState().setEngine(engine)
    await useUpdates.getState().check()
  }

  const reload = useCallback(async () => {
    const request = ++detectionRequest.current
    const location = await invoke('engine:describe', engine)
    if (request !== detectionRequest.current) return
    setInfo(location)
    void useEngineRegistry.getState().load(true)
  }, [engine])
  useEffect(() => {
    setInfo(null)
    void reload()
    void useUpdates.getState().setEngine(engine)
    return () => {
      detectionRequest.current += 1
      if (detectionTimer.current) clearTimeout(detectionTimer.current)
    }
  }, [engine, reload])

  const setOverride = (path: string | null) => {
    detectionRequest.current += 1
    setInfo(null)
    if (engine === 'pi') update({ engineOverridePath: path })
    else
      update({
        engineOverridePaths: { ...useApp.getState().prefs.engineOverridePaths, [engine]: path }
      })
    // Prefs persist on a short debounce; re-detect afterwards.
    if (detectionTimer.current) clearTimeout(detectionTimer.current)
    detectionTimer.current = setTimeout(() => void reload(), 400)
    toast({
      level: 'info',
      title: path ? `${label} location changed` : `Using the detected ${label.toLowerCase()}`,
      description: 'New sessions use it. Restart open sessions to switch now.',
      action: { label: 'Restart engines', onClick: () => restartEngines(engine) }
    })
  }

  return (
    <>
      {info ? (
        <div className="mb-7 flex items-center gap-5 rounded-card bg-surface-2 p-5 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-sm)]">
          <div className="flex size-14 items-center justify-center rounded-lg bg-surface-3 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
            <Cpu className={cn('size-7', info.found ? 'text-fg-2' : 'text-fg-4')} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="heading text-lg font-semibold text-fg">
                {info.found ? `${label} ${info.version ?? ''}` : `${label} not found`}
              </span>
              {info.found ? (
                <Badge tone="success">
                  <CheckCircle2 className="mr-1 size-3" />
                  Detected
                </Badge>
              ) : (
                <Badge tone="warning">Missing</Badge>
              )}
              {info.mock && <Badge tone="warning">Mock</Badge>}
            </div>
            <div className="mt-1 truncate font-mono text-xs text-fg-3">
              {info.found ? info.packageDir : info.error}
            </div>
          </div>
          <Button variant="secondary" loading={updates?.checking} onClick={() => void check()}>
            Check for updates
          </Button>
        </div>
      ) : (
        <Skeleton className="mb-7 h-24 w-full rounded-card" />
      )}

      {snapshot?.isolated && (
        <Callout tone="info" icon={<Info />} title="Isolated configuration">
          Vengeance is using a separate engine folder (
          <code className="font-mono text-xs">{snapshot.agentDir}</code>), not your everyday one.
        </Callout>
      )}

      <Group title="Location">
        <Row
          label="Detected from"
          description="Uses the engine included with Vengeance, unless you choose a custom location."
        >
          <span className="text-ui text-fg-2">
            {info?.source ? SOURCE_LABEL[info.source] : '—'}
          </span>
        </Row>
        <Row
          settingKey="engine.override"
          label="Custom location"
          description="For development or testing. Leave empty to use the Vengeance build."
          onReset={override ? () => setOverride(null) : undefined}
          resetLabel="Use bundled engine"
          below={
            <TextField
              mono
              browse="folder"
              value={override ?? undefined}
              placeholder="Included with Vengeance"
              onCommit={(v) => setOverride(v ?? null)}
            />
          }
        />
        {info?.cliPath && (
          <Row
            label="CLI"
            description={
              <span className="font-mono text-xs break-all text-fg-3">{info.cliPath}</span>
            }
          />
        )}
        {info?.nodeVersion && (
          <Row
            label="Runtime"
            description={
              info.runtime === 'electron'
                ? 'Runs on the Node built into Vengeance.'
                : `System Node at ${info.nodePath ?? 'PATH'}.`
            }
          >
            <span className="tabular text-ui text-fg-2">Node {info.nodeVersion}</span>
          </Row>
        )}
        {info?.sdkVersion && (
          <Row
            label="Config SDK"
            description="Version of the engine library Vengeance uses for settings, auth and packages."
          >
            <span className="tabular text-ui text-fg-2">{info.sdkVersion}</span>
          </Row>
        )}
      </Group>

      <Group title="Maintenance">
        <Row
          settingKey="engine.systemPrompt"
          label="System prompt & instructions"
          description="Read the built-in foundation and an open session’s prompt. Edit or restore global and project instructions."
        >
          <Button
            size="sm"
            variant="secondary"
            leading={<ScrollText />}
            onClick={() => {
              useApp.getState().openSettings('sessions', engine)
              useSettings.getState().setHighlight('instructions.builtIn')
            }}
          >
            Edit prompts
          </Button>
        </Row>
        <Row
          label="Configuration folder"
          description={
            <span className="font-mono text-xs text-fg-3">{snapshot?.agentDir ?? '…'}</span>
          }
        >
          <Button
            size="sm"
            variant="secondary"
            leading={<FolderOpen />}
            disabled={!snapshot}
            onClick={() => snapshot && void invoke('settings:open-path', snapshot.agentDir)}
          >
            Open
          </Button>
        </Row>
        <Row
          label={`Restart ${label.toLowerCase()} sessions`}
          description="Running agents finish first; sessions resume where they were."
        >
          <Button
            size="sm"
            variant="secondary"
            leading={<RotateCcw />}
            onClick={() => restartEngines(engine)}
          >
            Restart
          </Button>
        </Row>
        <Row
          settingKey="engine.changelog"
          label="What’s new"
          description="Release notes of the installed engine version."
        >
          <Button
            size="sm"
            variant="secondary"
            leading={<ScrollText />}
            onClick={() => openChangelog(engine)}
          >
            Changelog
          </Button>
        </Row>
        <Row
          settingKey="engine.models"
          label="Refresh model catalogs"
          description="Fetch the latest model list, limits and prices now instead of waiting for the next automatic refresh."
        >
          <Button
            size="sm"
            variant="secondary"
            leading={<DatabaseZap />}
            disabled={busy}
            onClick={() =>
              void runUpdate({ target: 'models', engine }, 'Refreshing model catalogs').then(() =>
                openUpdates()
              )
            }
          >
            Refresh
          </Button>
        </Row>
        <Row
          label="Engine updates"
          description="Both engines update with Vengeance. Reinstall Vengeance to repair missing or damaged engine files."
        />
        {engine === 'pi' && (
          <Row
            settingKey="engine.offline"
            label="Work offline"
            description="Pause background update checks and start new sessions offline (no model catalog refreshes). For metered or air-gapped connections."
          >
            <Switch
              aria-label="Work offline"
              checked={offline}
              onCheckedChange={(on) => void setOffline(on)}
            />
          </Row>
        )}
        <Diagnostics engine={engine} />
      </Group>
      {engine === 'prime' && <PrimeSettingsGroups section="engine" />}
    </>
  )
}
