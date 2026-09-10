/** Browser-safe status of DPH-owned Codex requests. */
export type { Config } from './config.ts'

export interface CodexTaskView {
  id: string
  sessionId: string | null
  model: string
  status: 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  pid: number | null
  exitCode: number | null
  error: string | null
}

/** Credential-free health and bounded request queue view. */
export interface CodexStatus {
  enabled: boolean
  paused: boolean
  version: string | null
  authentication: 'unknown' | 'chatgpt' | 'required' | 'other'
  error: string | null
  tasks: CodexTaskView[]
}
