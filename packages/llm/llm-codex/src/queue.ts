/** FIFO admission, durable status and cancellation for DPH-owned CLI calls. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { executeCli } from './process.ts'
import { prepareCodexRequest } from './images.ts'
import { redact, responseChunks, serialize } from './protocol.ts'
import type { CodexTaskView } from './types.ts'

interface Pending {
  view: CodexTaskView
  config: Config
  options: GenerateOptions
  attachments: AttachmentStore | undefined
  abort: AbortController
  resolve: (chunks: StreamChunk[]) => void
  reject: (error: unknown) => void
  detach: () => void
}

/** Single-instance queue; each slot is held until its process tree is gone. */
export class CodexQueue {
  paused = false
  private stopped = false
  private active: Pending | undefined
  private pending: Pending[] = []
  private history: CodexTaskView[] = []
  private writes: Promise<void> = Promise.resolve()
  private draining: Promise<void> | undefined
  private readonly ready: Promise<void>

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly root: string,
    private readonly current: () => Config,
    private readonly resolveAttachments: () => AttachmentStore | undefined = () => undefined,
  ) {
    this.ready = this.restore()
    // Consumers still observe restore failures; prevent an idle service from
    // producing an unhandled rejection before its first status request.
    void this.ready.catch(() => {})
  }

  private async restore(): Promise<void> {
    let text: string
    try { text = await readFile(join(this.root, 'tasks.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const data: unknown = JSON.parse(text)
    if (!Array.isArray(data)) throw new Error('Codex tasks.json must contain an array')
    this.history = data.slice(-this.current().retainedTasks).map(value => {
      if (typeof value !== 'object' || value === null || typeof value.id !== 'string' || typeof value.status !== 'string'
        || !['queued', 'starting', 'running', 'completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(value.status)
        || typeof value.model !== 'string' || typeof value.createdAt !== 'string'
        || !['sessionId', 'startedAt', 'finishedAt', 'error'].every(key => value[key] === null || typeof value[key] === 'string')
        || !['pid', 'exitCode'].every(key => value[key] === null || Number.isSafeInteger(value[key]))) throw new Error('Invalid Codex task record')
      const view = value as CodexTaskView
      if (['queued', 'starting', 'running'].includes(view.status)) {
        return { ...view, status: 'interrupted', pid: null, finishedAt: new Date().toISOString(), error: 'DPH restarted; continue the original DPH conversation to retry.' } as CodexTaskView
      }
      return view
    })
    await this.persist()
  }

  private persist(): Promise<void> {
    const active = this.history.filter(v => ['queued', 'starting', 'running'].includes(v.status))
    const terminal = this.history.filter(v => !active.includes(v)).slice(-this.current().retainedTasks)
    this.history = [...terminal, ...active]
    const snapshot = JSON.stringify(this.history)
    this.writes = this.writes.then(() => writeFileAtomic(join(this.root, 'tasks.json'), snapshot, { mode: 0o600, dirMode: 0o700 }))
    return this.writes
  }

  /** Return detached task metadata without prompts or credentials. */
  async list(): Promise<CodexTaskView[]> { await this.ready; return this.history.map(view => ({ ...view })) }

  /** Queue one assembled request; caller cancellation also removes unstarted work.
   * @param options - provider-neutral DPH request.
   * @returns chunks after validated CLI completion.
   */
  async run(options: GenerateOptions): Promise<StreamChunk[]> {
    await this.ready
    const config = { ...this.current() }
    if (this.stopped || !config.enabled) throw new LlmError('Codex provider is disabled', 'CODEX_DISABLED')
    options.signal?.throwIfAborted()
    if (this.pending.length >= config.maxQueueSize) throw new LlmError('Codex queue is full', 'CODEX_QUEUE_FULL')
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    const attachments = hasImages ? this.resolveAttachments() : undefined
    if (hasImages && attachments === undefined) throw new LlmError('Codex image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
    return new Promise<StreamChunk[]>((resolve, reject) => {
      const view: CodexTaskView = {
        id: randomUUID(), sessionId: options.sessionId ?? null, model: options.model, status: 'queued',
        createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, pid: null, exitCode: null, error: null,
      }
      const abort = new AbortController()
      const cancel = (): void => { this.cancel(view.id) }
      options.signal?.addEventListener('abort', cancel, { once: true })
      const job: Pending = { view, config, options, attachments, abort, resolve, reject,
        detach: () => options.signal?.removeEventListener('abort', cancel) }
      this.history.push(view)
      this.pending.push(job)
      // Admission is durable before draining; failures reject rather than silently dropping work.
      void this.persist().then(() => this.kick(), error => {
        this.pending = this.pending.filter(candidate => candidate !== job)
        job.detach(); reject(error)
      })
      if (options.signal?.aborted) cancel()
    })
  }

  private kick(): void {
    if (this.draining !== undefined || this.paused || this.stopped) return
    this.draining = this.drain().finally(() => {
      this.draining = undefined
      if (this.pending.length && !this.paused && !this.stopped) this.kick()
    })
  }

  private async drain(): Promise<void> {
    while (!this.paused && !this.stopped) {
      const job = this.pending.shift()
      if (job === undefined) return
      this.active = job
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; job.abort.abort(new Error('Codex execution timeout')) }, job.config.timeoutSeconds * 1000)
      try {
        job.view.status = 'starting'; job.view.startedAt = new Date().toISOString()
        await this.persist()
        const prepared = await prepareCodexRequest(job.options, job.attachments)
        const prompt = serialize(prepared.options, prepared.images)
        if (Buffer.byteLength(prompt) > job.config.maxOutputBytes) throw new LlmError('Codex request exceeded the configured byte limit', 'CODEX_INPUT_LIMIT')
        const result = await executeCli(this.subprocess, this.root, job.config, prepared.options, prompt, job.abort.signal, handle => {
          job.view.pid = handle.pid
          job.view.status = 'running'
          void this.persist().catch(error => { job.abort.abort(error) })
        }, prepared.images)
        job.view.exitCode = result.exitCode
        const chunks = responseChunks(result.text, job.options, result.usage)
        job.view.status = 'completed'
        job.view.finishedAt = new Date().toISOString()
        await this.persist()
        job.resolve(chunks)
      } catch (error) {
        const failure = timedOut ? new LlmError('Codex exceeded its execution timeout', 'TIMEOUT')
          : job.abort.signal.aborted ? new LlmError('Codex request cancelled', 'ABORTED')
            : error
        job.view.status = timedOut ? 'timeout' : job.abort.signal.aborted ? 'cancelled' : 'failed'
        job.view.error = redact(failure instanceof Error ? failure.message : String(failure))
        job.view.finishedAt = new Date().toISOString()
        if (failure instanceof LlmError && failure.code === 'RATE_LIMIT') this.paused = true
        try { await this.persist() } catch (persistenceError) { this.paused = true; job.reject(persistenceError) }
        job.reject(failure)
      } finally {
        clearTimeout(timer); job.detach(); this.active = undefined
      }
    }
  }

  /** Cancel only a request owned by this queue.
   * @param id - request id shown by list().
   * @returns whether live work was cancelled.
   */
  cancel(id: string): boolean {
    if (this.active?.view.id === id) { this.active.abort.abort(); return true }
    const index = this.pending.findIndex(job => job.view.id === id)
    if (index < 0) return false
    const job = this.pending.splice(index, 1)[0]!
    job.detach(); job.view.status = 'cancelled'; job.view.finishedAt = new Date().toISOString()
    job.reject(new LlmError('Queued Codex request cancelled', 'ABORTED'))
    void this.persist().catch(() => { this.paused = true })
    return true
  }

  /** Pause admission to execution without stopping the active process.
   * @param value - true to pause, false to drain retained requests.
   */
  setPaused(value: boolean): void { this.paused = value; if (!value) this.kick() }

  /** Abort owned work and await process-tree and disk quiescence. */
  async dispose(): Promise<void> {
    this.stopped = true
    await this.ready
    for (const job of [...this.pending]) this.cancel(job.view.id)
    this.active?.abort.abort()
    await this.draining
    await this.writes
  }
}
