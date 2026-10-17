import { ArrowUp, CornerDownRight, ListEnd, Paperclip, Square, SquareTerminal } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useAgents } from '../../store/agents'
import { Button, IconButton, Kbd, Tooltip } from '../../ui'
import { ContextMeter } from '../chat/ContextRing'
import { PrimeControls } from '../engines/prime-controls'
import { SessionEngineMenu } from '../engines/SessionEngineMenu'
import { supportsEngineCommand, useEngineCapabilities } from '../engines/registry'
import { ModeHint } from './editor-hints'
import { ModelPill } from './model-pill'
import { SpeedPill } from './speed-pill'
import { ThinkingPill } from './thinking-pill'
import { TokenSpeed } from './token-speed'

/*
 * The footer stays one row at every composer width (the composer is `@container/composer`). The
 * steps are in em of the UI text size, so larger text compacts sooner:
 *   below 52em  Engine, Steer and Follow-up drop their labels and the send hint hides;
 *               a running Engine 2 session drops its Engine and Controls labels sooner, below
 *               62em (engines/SessionEngineMenu.tsx, engines/prime-controls.tsx);
 *   below 40em  thinking and speed keep only their glyphs and the context
 *               meter keeps only its ring.
 * Between steps the model name truncates to absorb what is left.
 */
const compactLabel = '@max-[52em]/composer:hidden'
const compactIconButton = '@max-[52em]/composer:w-8 @max-[52em]/composer:px-0'

interface ComposerFooterProps {
  agentId: string
  ready: boolean
  running: boolean
  compacting: boolean
  hasContent: boolean
  hasAttachments: boolean
  menuOpen: boolean
  text: string
  bashMode: 'include' | 'exclude' | null
  onPickAttachments(): void
  onStop(): void
  onSubmit(mode: 'steer' | 'followUp'): void
}

export function ComposerFooter({
  agentId,
  ready,
  running,
  compacting,
  hasContent,
  hasAttachments,
  menuOpen,
  text,
  bashMode,
  onPickAttachments,
  onStop,
  onSubmit
}: ComposerFooterProps) {
  const engine = useAgents((state) => state.agents[agentId]?.info.engine ?? 'pi')
  const contextUsage = useAgents((state) => state.agents[agentId]?.stats?.contextUsage)
  useEngineCapabilities(engine)
  const canSteer = supportsEngineCommand(engine, 'steer')
  const canFollowUp = supportsEngineCommand(engine, 'follow_up')

  return (
    <div data-composer-footer className="flex items-end gap-2 px-2 pt-0.5 pb-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <IconButton label="Attach images or files" size="sm" onClick={onPickAttachments}>
          <Paperclip />
        </IconButton>
        <SessionEngineMenu agentId={agentId} />
        {supportsEngineCommand(engine, 'set_model') && <ModelPill agentId={agentId} />}
        {supportsEngineCommand(engine, 'set_thinking_level') && <ThinkingPill agentId={agentId} />}
        <SpeedPill agentId={agentId} />
        {engine === 'prime' && <PrimeControls agentId={agentId} disabled={!ready} />}
        {engine === 'prime' && <TokenSpeed agentId={agentId} />}
        {!hasAttachments && !running && !compacting && (
          <ModeHint text={text} bashMode={bashMode} engine={engine} />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ContextMeter usage={contextUsage} />
        {running || compacting ? (
          <>
            {supportsEngineCommand(engine, 'abort') && (
              <Tooltip content="Stop" hotkey="escape+escape" side="top">
                <Button
                  variant="secondary"
                  aria-label="Stop"
                  onClick={onStop}
                  className="size-8 px-0"
                >
                  <Square className="!size-3 fill-current" />
                </Button>
              </Tooltip>
            )}
            {canSteer && !compacting && (
              <Tooltip
                content="Steer: delivered after the current tool calls"
                hotkey="enter"
                side="top"
              >
                <Button
                  variant="primary"
                  size="md"
                  aria-label="Steer"
                  disabled={!hasContent || !ready}
                  onClick={() => onSubmit('steer')}
                  leading={<CornerDownRight />}
                  className={cn('px-2.5', compactIconButton)}
                >
                  <span className={compactLabel}>Steer</span>
                </Button>
              </Tooltip>
            )}
            {canFollowUp && !compacting && (
              <Tooltip
                content="Follow-up: delivered when the agent finishes"
                hotkey="alt+enter"
                side="top"
              >
                <Button
                  variant="secondary"
                  size="md"
                  aria-label="Follow-up"
                  disabled={!hasContent || !ready}
                  onClick={() => onSubmit('followUp')}
                  leading={<ListEnd />}
                  className={cn('px-2.5', compactIconButton)}
                >
                  <span className={compactLabel}>Follow-up</span>
                </Button>
              </Tooltip>
            )}
          </>
        ) : (
          <>
            {hasContent && !menuOpen && (
              <span className="inline-flex items-center gap-1 px-1 text-2xs whitespace-nowrap text-fg-3 @max-[52em]/composer:hidden">
                <Kbd combo="enter" size="xs" /> {bashMode ? 'run' : 'send'}
              </span>
            )}
            <Tooltip content={bashMode ? 'Run command' : 'Send'} hotkey="enter" side="top">
              <Button
                variant="primary"
                aria-label="Send"
                disabled={!hasContent || !ready}
                onClick={() => onSubmit('steer')}
                className="size-8 rounded-full px-0"
              >
                {bashMode ? <SquareTerminal /> : <ArrowUp strokeWidth={2.25} />}
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}
