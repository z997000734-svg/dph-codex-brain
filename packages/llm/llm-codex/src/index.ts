/** Local Codex provider and credential-free management over authenticated DPH RPC. */
import { mkdir } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { Config } from './config.ts'
import { CodexAdapter } from './adapter.ts'
import { CodexQueue } from './queue.ts'
import { redact } from './protocol.ts'
import type { CodexStatus } from './types.ts'

export { Config } from './config.ts'
export type { CodexStatus, CodexTaskView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { codexBrain: CodexBrainRuntime }
}

/** Owns the single Codex queue in a local DPH host. */
export class CodexBrainRuntime extends TypertRemoteService {
  static inject = ['llm', 'subprocess', 'settings', 'agentDefaultModel']
  static Config = Config
  private current: () => Config
  private readonly queue: CodexQueue
  private version: string | null = null
  private authentication: CodexStatus['authentication'] = 'unknown'
  private error: string | null = null
  private readonly root = dshHomePath('brains', 'codex')

  constructor(ctx: Context, config: Config) {
    super(ctx, 'codexBrain')
    this.current = () => config
    this.queue = new CodexQueue(ctx.subprocess, this.root, () => this.current(), () => ctx.get('attachments'))
    const adapter = new CodexAdapter(this.queue, () => this.current())
    let registration: ReturnType<typeof ctx.llm.registerAdapter> | undefined
    const updateRoute = (): void => {
      const routes = this.current().enabled ? ['codex'] : []
      if (registration) registration.replace(routes)
      else if (routes.length) registration = ctx.llm.registerAdapter(routes, adapter)
      if (!this.current().enabled) this.queue.setPaused(true)
    }
    ctx.settings.installSection(ctx, 'llm-codex', Config, config, {
      setSource: source => { this.current = source },
      onChange: updateRoute,
    })
    updateRoute()
    ctx.effect(() => () => this.queue.dispose(), 'codex: owned queue teardown')
  }

  /** Read bounded task status; includes no credentials or raw prompts.
   * @returns current provider health and DPH-owned queue.
   */
  @Remote
  async status(): Promise<CodexStatus> {
    return { enabled: this.current().enabled, paused: this.queue.paused, version: this.version,
      authentication: this.authentication, error: this.error, tasks: await this.queue.list() }
  }

  private async probe(args: string[]): Promise<{ code: number | null; text: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const child = this.ctx.subprocess.spawn({
      argv: [this.current().command, ...args], cwd: this.root, graceMs: this.current().graceMs,
      signal: AbortSignal.timeout(10000),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      env: { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined },
    })
    try {
      const result = await child.done
      return { code: result.exitCode, text: `${child.collected.stdout?.readFrom(0).text ?? ''}\n${child.collected.stderr?.readFrom(0).text ?? ''}` }
    } finally { child.terminate(); await child.waitForExit() }
  }

  /** Detect the executable and official authentication mode without reading auth files.
   * @returns credential-free connection status.
   */
  @Remote
  async detect(): Promise<CodexStatus> {
    this.error = null
    try {
      const version = await this.probe(['--version'])
      if (version.code !== 0 || !/codex-cli\s+\d+\./.test(version.text)) throw new Error('The configured executable is not Codex CLI')
      this.version = version.text.match(/codex-cli\s+[^\s]+/)![0]
      const auth = await this.probe(['login', 'status'])
      this.authentication = auth.code !== 0 ? 'required' : /chatgpt/i.test(auth.text) ? 'chatgpt' : 'other'
      if (this.authentication !== 'chatgpt') this.error = 'Use the official codex login command and sign in with ChatGPT.'
    } catch (error) {
      this.version = null; this.authentication = 'unknown'
      this.error = redact(error instanceof Error ? error.message : String(error))
    }
    return this.status()
  }

  /** Run a tiny model request through the same queue and output parser as real work.
   * @returns a final text response after the CLI has closed.
   */
  @Remote
  async test(): Promise<string> {
    const health = await this.detect()
    if (health.authentication !== 'chatgpt') throw new LlmError(health.error ?? 'ChatGPT login required', 'CODEX_AUTH_REQUIRED')
    const chunks = await this.queue.run({ provider: 'codex', model: this.current().model,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply exactly OK.' }], source: { kind: 'user' } })] })
    return chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  }

  /** Pause queued requests or resume them after a limit clears.
   * @param paused - desired queue state.
   */
  @Remote
  pause(paused: boolean): void { this.queue.setPaused(paused) }

  /** Cancel a single DPH-owned request, never an unrelated Codex process.
   * @param id - queue request id.
   * @returns whether a queued or running request was found.
   */
  @Remote
  cancel(id: string): boolean { return this.queue.cancel(id) }

  /** Save Codex as the default provider for new DPH agents. */
  @Remote
  async setDefault(): Promise<void> {
    if (!this.current().enabled) throw new Error('Enable Codex before setting it as default')
    await this.ctx.agentDefaultModel.saveSelection({ provider: 'codex', model: this.current().model })
  }

  /** Read non-secret CLI settings for the management form.
   * @returns a detached configuration snapshot.
   */
  @Remote
  configuration(): Config { return { ...this.current() } }

  /** Validate and save the management form through DPH settings.
   * @param value - complete non-secret CLI configuration.
   */
  @Remote
  async configure(value: Config): Promise<void> {
    const next = Config(value)
    await this.ctx.settings.replace('llm-codex', { ...next })
    this.queue.setPaused(!next.enabled)
  }
}

export default CodexBrainRuntime
