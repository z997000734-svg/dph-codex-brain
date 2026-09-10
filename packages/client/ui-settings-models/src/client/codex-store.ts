/** Management callbacks and a framework-readable snapshot for the Codex section. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CodexStatus } from '@deepseek-ai/dsh-api-remotes/client'

/** Configuration fields edited by the Codex management section. */
export interface CodexConfiguration {
  enabled: boolean
  command: string
  model: string
  proxyUrl: string
  timeoutSeconds: number
  graceMs: number
  maxOutputBytes: number
  maxQueueSize: number
  retainedTasks: number
}

/** Wire-independent management actions. */
export interface CodexOperations {
  status(): Promise<CodexStatus>
  configuration(): Promise<CodexConfiguration>
  configure(value: CodexConfiguration): Promise<void>
  detect(): Promise<CodexStatus>
  test(): Promise<string>
  pause(value: boolean): Promise<void>
  cancel(id: string): Promise<boolean>
  setDefault(): Promise<void>
}

/** State shared between remounts of the management section. */
export interface CodexState {
  status: CodexStatus | null
  config: CodexConfiguration | null
  busy: boolean
  error: string | null
  result: string | null
}

/** Keeps polling out of components and contains connection errors. */
export class CodexController {
  readonly store = createSnapshotStore<CodexState>({ status: null, config: null, busy: false, error: null, result: null })
  private timer: ReturnType<typeof setInterval> | undefined
  private loading = false
  private disposed = false
  private activeActions = 0

  constructor(private readonly operations: CodexOperations) {}

  /** Start management-view refreshes; stops when the view unmounts.
   * @returns view-owned cleanup.
   */
  watch(): () => void {
    void this.refresh()
    this.timer ??= setInterval(() => { void this.refresh() }, 3000)
    return () => { clearInterval(this.timer); this.timer = undefined }
  }

  /** Read the live request queue without overwriting an edited form. */
  async refresh(): Promise<void> {
    if (this.loading || this.disposed) return
    this.loading = true
    try {
      const status = await this.operations.status()
      const config = this.store.getSnapshot().config ?? await this.operations.configuration()
      if (!this.disposed) this.store.update(state => { state.status = status; state.config = config })
    } catch (error) {
      if (!this.disposed) this.store.update(state => { state.error = error instanceof Error ? error.message : String(error) })
    } finally { this.loading = false }
  }

  /** Execute one form action and publish its result.
   * @param action - management operation name.
   * @param value - configuration, request id, or pause setting.
   */
  async act(action: 'save' | 'detect' | 'test' | 'pause' | 'cancel' | 'default', value?: CodexConfiguration | string | boolean): Promise<boolean> {
    if (this.store.getSnapshot().busy && action !== 'cancel') return false
    this.activeActions++
    this.store.update(state => { state.busy = true; state.error = null; state.result = null })
    try {
      let result: string | null = null
      switch (action) {
        case 'save': {
          await this.operations.configure(value as CodexConfiguration)
          const config = await this.operations.configuration()
          this.store.update(state => { state.config = config })
          break
        }
        case 'detect': await this.operations.detect(); break
        case 'test': result = await this.operations.test(); break
        case 'pause': await this.operations.pause(value as boolean); break
        case 'cancel': await this.operations.cancel(value as string); break
        case 'default': await this.operations.setDefault(); break
      }
      if (!this.disposed) this.store.update(state => { state.result = result })
      await this.refresh()
      return true
    } catch (error) {
      if (!this.disposed) this.store.update(state => { state.error = error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      this.activeActions--
      if (!this.disposed) this.store.update(state => { state.busy = this.activeActions > 0 })
    }
  }

  /** Stop refreshes when the plugin unloads. */
  dispose(): void { this.disposed = true; clearInterval(this.timer) }
}
