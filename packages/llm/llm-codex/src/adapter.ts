/** Registers Codex as a provider of ordinary DPH text and tool decisions. */
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.ts'
import type { CodexQueue } from './queue.ts'

/** Stateless request projection; DPH owns conversation history and tools. */
export class CodexAdapter extends LlmAdapter {
  constructor(private readonly queue: CodexQueue, private readonly current: () => Config) { super() }

  override providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: 'OpenAI Codex (Local CLI)' } }

  override providerRetryPolicy(): ReturnType<typeof resolveRetryPolicy> {
    // Queue pauses on rate limits; automatic retries could duplicate work or starve the user's CLI.
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'codex')
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: this.current().model, name: this.current().model === 'default' ? 'Codex CLI default' : this.current().model, inputModalities: ['text', 'image'] }]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model !== this.current().model) throw new LlmError('Select the model configured in Codex settings', 'UNKNOWN_MODEL')
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of await this.queue.run(options)) yield chunk
  }
}
