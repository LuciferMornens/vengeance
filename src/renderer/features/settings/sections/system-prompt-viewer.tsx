import { useEffect, useRef, useState } from 'react'
import { AlertCircle, BookOpen, Copy } from 'lucide-react'
import { ENGINE_LABELS } from '@shared/api/engine'
import { useApp } from '../../../store/app'
import { Button, Dialog, toast } from '../../../ui'
import { copyText } from '../../../ui/CopyButton'
import { settingsInvokeForFolder } from '../ipc'
import { Callout, Row } from '../layout'
import { useSettings } from '../store'

/**
 * The selected engine's native foundation, read-only, with a path to customize it as SYSTEM.md. An open
 * conversation's assembled prompt lives with that conversation (its Instructions dialog), not here.
 */
export function FoundationPromptRow({
  onCustomize,
  canCustomize
}: {
  onCustomize: (text: string) => void
  canCustomize: boolean
}) {
  const engine = useSettings((state) => state.engine)
  const cwd = useApp((state) => state.prefs.activeWorkspace)
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readRevision = useRef(0)

  useEffect(
    () => () => {
      readRevision.current++
    },
    []
  )

  const read = async () => {
    const revision = ++readRevision.current
    setLoading(true)
    setError(null)
    try {
      const result = await settingsInvokeForFolder(engine, cwd, 'settings:system-prompt-default')
      if (readRevision.current === revision) setText(result.text)
    } catch (failure) {
      if (readRevision.current === revision)
        setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (readRevision.current === revision) setLoading(false)
    }
  }

  return (
    <>
      <Row
        settingKey="instructions.builtIn"
        label="Built-in foundation"
        description="Read the engine’s native starting instructions, or use them as a draft for your own foundation."
      >
        <Button
          size="sm"
          variant="secondary"
          leading={<BookOpen />}
          loading={loading}
          onClick={() => void read()}
        >
          View default
        </Button>
      </Row>
      {error && (
        <div className="px-4 pb-3" role="alert">
          <Callout tone="danger" icon={<AlertCircle />} title="Could not read the foundation">
            {error}
          </Callout>
        </div>
      )}
      <Dialog
        open={text !== null}
        size="editor"
        icon={<BookOpen />}
        title={`${ENGINE_LABELS[engine]} built-in foundation`}
        description={`${engine === 'prime' ? 'Bundled Engine 2 native foundation.' : 'Selected Engine native defaults with default tool rules.'} User files and session-specific additions are excluded. Runtime model and tool rules may differ.`}
        onOpenChange={(open) => !open && setText(null)}
        footerStart={
          <Button
            size="sm"
            variant="ghost"
            leading={<Copy />}
            onClick={() => {
              if (text !== null)
                void copyText(text).then((copied) =>
                  toast(
                    copied
                      ? { level: 'success', title: 'Prompt copied' }
                      : {
                          level: 'error',
                          title: 'Could not copy prompt',
                          description: 'Select the text and copy it manually.'
                        }
                  )
                )
            }}
          >
            Copy
          </Button>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setText(null)}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={!canCustomize}
              onClick={() => {
                if (text !== null) onCustomize(text)
                setText(null)
              }}
            >
              Customize foundation
            </Button>
          </>
        }
      >
        <pre className="selectable max-h-[43vh] overflow-auto rounded-md bg-surface-1 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words text-fg-2 shadow-elev-0">
          {text}
        </pre>
      </Dialog>
    </>
  )
}
