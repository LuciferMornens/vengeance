import { Component, useState, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'
import { useAgents } from '../../store/agents'
import { Button } from '../../ui'
import { CopyButton } from '../../ui/CopyButton'

interface TranscriptBoundaryProps {
  agentId: string
  children: ReactNode
}

interface TranscriptBoundaryState {
  error: Error | null
}

/** A transcript failure must leave the session header, composer, Stop and sidebar mounted. */
export class TranscriptBoundary extends Component<
  TranscriptBoundaryProps,
  TranscriptBoundaryState
> {
  override state: TranscriptBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): TranscriptBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <TranscriptRecovery
        agentId={this.props.agentId}
        error={this.state.error}
        onRetry={() => this.setState({ error: null })}
      />
    )
  }
}

function TranscriptRecovery({
  agentId,
  error,
  onRetry
}: {
  agentId: string
  error: Error
  onRetry: () => void
}) {
  const [pending, setPending] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const diagnostics = error.stack ?? error.message

  const retry = async (): Promise<void> => {
    setPending(true)
    setRefreshError(null)
    try {
      // Refresh reloads committed history only when idle; a running turn keeps its live state.
      await useAgents.getState().refresh(agentId)
      onRetry()
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-auto px-8 pb-[var(--composer-h)]">
      <div className="m-auto w-full max-w-md py-8">
        <div role="alert">
          <TriangleAlert className="mb-4 size-6 text-warning" />
          <h2 className="text-lg font-semibold text-fg">Conversation display interrupted</h2>
          <p className="mt-2 text-sm leading-relaxed text-fg-2">
            Vengeance couldn’t display this conversation. Your session controls are still available
            below. Try again to restore the view.
          </p>
        </div>
        <Button
          className="mt-5"
          variant="secondary"
          leading={<RotateCcw />}
          loading={pending}
          onClick={() => void retry()}
        >
          Try again
        </Button>
        {refreshError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {refreshError}
          </p>
        )}
        <details className="mt-5 border-t border-hairline-soft pt-3 text-xs text-fg-3">
          <summary className="cursor-pointer hover:text-fg-2">Error details</summary>
          <pre className="selectable mt-3 max-h-40 overflow-auto font-mono text-2xs break-words whitespace-pre-wrap">
            {diagnostics}
          </pre>
          <CopyButton value={diagnostics} label="Copy error details" showLabel className="mt-2" />
        </details>
      </div>
    </div>
  )
}
