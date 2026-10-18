import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { create } from 'zustand'
import { invoke, platform } from '../../lib/ipc'
import { Button, Dialog, Mark, Skeleton } from '../../ui'
import { CopyButton } from '../../ui/CopyButton'

/** Source repository of the Engine package (its package.json `repository`). */
const ENGINE_SOURCE_URL = 'https://github.com/earendil-works/pi'

const OS_NAMES: Record<typeof platform.os, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

const useAbout = create<{ open: boolean }>(() => ({ open: false }))

/** Open the About dialog (titlebar mark, palette, Settings). */
export function openAbout(): void {
  useAbout.setState({ open: true })
}

/** The installed Engine's version while the dialog is open; null while it loads. */
function useEngineVersion(open: boolean): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let current = true
    invoke('engine:info')
      .then((info) => current && setVersion(info.found ? (info.version ?? 'Unknown') : 'Not found'))
      .catch(() => current && setVersion('Unavailable'))
    return () => {
      current = false
    }
  }, [open])
  return version
}

/** Version facts for bug reports: Vengeance, the Engine, the runtime and the OS. */
export function AboutDialog() {
  const open = useAbout((s) => s.open)
  const engineVersion = useEngineVersion(open)
  const system = `${OS_NAMES[platform.os]} ${platform.arch}`
  const facts: [label: string, value: string | null][] = [
    ['Engine', engineVersion],
    ['Electron', platform.versions.electron],
    ['System', system]
  ]
  const versionInfo = [`Vengeance ${platform.appVersion}`, ...facts.map(([label, value]) => `${label} ${value ?? '…'}`)].join('\n')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => useAbout.setState({ open: next })}
      size="confirm"
      icon={<Mark size={16} />}
      title="Vengeance"
      description={<span className="tabular">Version {platform.appVersion}</span>}
      footerStart={<CopyButton value={versionInfo} label="Copy version info" showLabel className="-ml-1.5" />}
      footer={
        <Button variant="ghost" size="sm" leading={<ExternalLink />} onClick={() => void invoke('sys:open-external', ENGINE_SOURCE_URL)}>
          Engine source
        </Button>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-card bg-surface-1 px-3.5 py-3 text-sm shadow-elev-0">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-3">{label}</dt>
            <dd className="tabular text-right text-fg-2">{value ?? <Skeleton className="ml-auto h-3.5 w-12" />}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3.5 mb-1 text-sm leading-relaxed text-fg-3">
        © 2026 LuciferMornens, under the Vengeance License:{' '}
        <span className="whitespace-nowrap">github.com/LuciferMornens/vengeance</span>. Runs on the open-source
        Engine by Earendil Works and Engine 2 by Prime Intellect (both MIT).
      </p>
    </Dialog>
  )
}
