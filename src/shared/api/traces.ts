export type PrimeTracesAction =
  | 'status'
  | 'on'
  | 'off'
  | 'preview'
  | 'preview-content'
  | 'upload'
  | 'upload-current'
  | 'upload-all'

export interface PrimeTracesArgs {
  agentId?: string
  cwd: string
  action: PrimeTracesAction
}

export interface PrimeTracePreview {
  sessionFile: string
  sessionId: string
  traceId: string
  parentSessionId?: string
  size: number
  maxBytes: number
  uploadable: boolean
  endpoint: string
  gitRepo?: string
  gitCommit?: string
  contentPreview: string
  truncated: boolean
}

export type PrimeTracesStatus =
  | 'ready'
  | 'uploaded'
  | 'disabled'
  | 'unchanged'
  | 'missing_credentials'
  | 'no_session_file'
  | 'empty_session'
  | 'invalid_session'
  | 'too_large'
  | 'failed'
  | 'cancelled'

export interface PrimeTracesResult {
  action: PrimeTracesAction
  status: PrimeTracesStatus
  enabled?: boolean
  credentialLabel?: string | null
  logPath?: string
  preview?: PrimeTracePreview
  uploaded?: number
  failed?: number
  skipped?: number
  total?: number
  bytesStored?: number
  size?: number
  maxBytes?: number
  statusCode?: number
  message?: string
}

export interface PrimeTracesProgress {
  cwd: string
  completed: number
  total: number
}

export interface PrimeTracesInvokeMap {
  'engine:traces': [args: PrimeTracesArgs, result: PrimeTracesResult]
  'engine:traces-cancel': [cwd: string, result: void]
}

export interface PrimeTracesEventMap {
  'engine:traces-progress': PrimeTracesProgress
}
