import { AlertTriangle, Check, X } from 'lucide-react'
import { Tooltip } from '../../ui'
import { DetailSection } from './ToolRow'
import type { LensVerdict } from './tool-utils'

function cleanLabel(lens: LensVerdict): string {
  if (lens.ok.length === 0) return 'Code checks ran'
  return `${lens.ok.join(', ')} clean`
}

/** Row meta for a code-intelligence verdict: a quiet check when clean, `⚠ 2` for warnings, `✕ 3 issues` for errors. */
export function LensMeta({ lens }: { lens: LensVerdict | null }) {
  if (!lens) return null
  if (lens.issues > 0) {
    return (
      <span data-lens="issues" className="inline-flex items-center gap-1 font-medium text-danger">
        <X className="size-3" strokeWidth={2.75} aria-hidden />
        {lens.issues === 1 ? '1 issue' : `${lens.issues} issues`}
      </span>
    )
  }
  if (lens.warnings > 0) {
    return (
      <Tooltip content={lens.warnings === 1 ? '1 warning from code checks' : `${lens.warnings} warnings from code checks`}>
        <span data-lens="warnings" className="inline-flex items-center gap-1 text-warning">
          <AlertTriangle className="size-3" aria-hidden />
          {lens.warnings}
        </span>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={cleanLabel(lens)}>
      <span data-lens="clean" aria-label={cleanLabel(lens)} className="inline-flex items-center text-fg-3">
        <Check className="size-3" strokeWidth={2.5} aria-hidden />
      </span>
    </Tooltip>
  )
}

/** The full verdict block under a detail's output, in a hairline-separated "Lens" section. */
export function LensSection({ lens }: { lens: LensVerdict | null }) {
  if (!lens) return null
  return (
    <DetailSection label="Lens">
      <pre className="selectable px-3.5 pt-1 pb-3 font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap text-fg-2">{lens.block}</pre>
    </DetailSection>
  )
}
