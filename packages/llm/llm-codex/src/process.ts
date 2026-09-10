/** Bounded official-CLI execution through DPH's process-tree service. */
import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { cliError, record, RESPONSE_SCHEMA } from './protocol.ts'

/** Native tools stay outside this text/tool-decision adapter. */
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use',
  'image_generation', 'multi_agent', 'multi_agent_v2', 'code_mode', 'code_mode_host',
  'view_image', 'workspace_dependencies', 'skill_search', 'tool_suggest', 'sleep_tool', 'memories',
  'unbounded_connection_retries',
]

/** Build arguments without shell expansion or user-global configuration edits.
 * @param config - frozen settings for this call.
 * @param schema - private schema path.
 * @param options - model selection and optional reasoning effort.
 * @returns executable argument vector.
 */
export function argvFor(
  config: Config,
  schema: string,
  options: Pick<GenerateOptions, 'model' | 'reasoningEffort'>,
  imagePaths: readonly string[] = [],
): string[] {
  const args = [config.command, 'exec', '--ignore-user-config', '--ephemeral', '--json',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--output-schema', schema,
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '-c', 'features.skip_host_skill_discovery=true',
    ...DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
  ]
  if (options.model !== 'default') args.push('--model', options.model)
  if (options.reasoningEffort !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`)
  for (const path of imagePaths) args.push('--image', path)
  args.push('-')
  return args
}

/** Result after the owned process has closed. */
export interface CliResult {
  text: string
  usage?: TokenUsage
  exitCode: number | null
}

/** Execute and completely settle one isolated Codex request.
 * @param subprocess - local execution service.
 * @param root - private DPH data directory.
 * @param config - frozen CLI settings.
 * @param options - selected model.
 * @param prompt - serialized DPH input.
 * @param signal - cancellation and execution deadline.
 * @param started - receives only the DPH-owned handle.
 * @returns validated final response transport data.
 */
export async function executeCli(
  subprocess: SubprocessRuntime, root: string, config: Config,
  options: Pick<GenerateOptions, 'model' | 'reasoningEffort'>, prompt: string,
  signal: AbortSignal, started: (handle: SubprocessHandle) => void,
  images: readonly RequestImageAttachment[] = [],
): Promise<CliResult> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const cwd = await mkdtemp(join(root, 'request-'))
  const schema = join(cwd, 'response.schema.json')
  const imagePaths: string[] = []
  let child: SubprocessHandle | undefined
  try {
    await writeFile(schema, JSON.stringify(RESPONSE_SCHEMA), { flag: 'wx', mode: 0o600 })
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const
    for (const [index, image] of images.entries()) {
      const path = join(cwd, `image-${String(index + 1).padStart(3, '0')}.${extension[image.mediaType]}`)
      await writeFile(path, image.data, { flag: 'wx', mode: 0o600 })
      imagePaths.push(path)
    }
    signal.throwIfAborted()
    child = subprocess.spawn({
      argv: argvFor(config, schema, options, imagePaths), cwd, graceMs: config.graceMs, signal,
      stdio: { stdin: { data: prompt }, stdout: 'pipe', stderr: { maxBytes: 8192 } },
      env: { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_THREAD_ID: undefined,
        ...(config.proxyUrl ? { HTTPS_PROXY: config.proxyUrl, HTTP_PROXY: config.proxyUrl, ALL_PROXY: config.proxyUrl } : {}) },
    })
    started(child)
    // Attach a rejection handler before consuming stdout; spawn failure may precede its close.
    const outcome = child.done.then(value => ({ value }), error => ({ error }))
    if (!child.stdout) throw new LlmError('Codex stdout is unavailable', 'CODEX_FAILED')
    let buffered = ''
    let bytes = 0
    let finalText: string | undefined
    let usage: TokenUsage | undefined
    let completed = false
    let failure: string | undefined
    const accept = (line: string): void => {
      if (!line.trim()) return
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { throw new LlmError('Codex emitted malformed JSONL', 'CODEX_PROTOCOL') }
      const event = record(parsed)
      if (event.type === 'turn.failed' || event.type === 'error') failure = JSON.stringify(event)
      if (event.type === 'turn.completed') {
        // The CLI can recover from transport errors before completing the turn.
        failure = undefined
        completed = true
        if (event.usage !== undefined) {
          const counts = record(event.usage)
          const input = counts.input_tokens, output = counts.output_tokens, cached = counts.cached_input_tokens ?? 0
          if (typeof input !== 'number' || typeof output !== 'number' || typeof cached !== 'number'
            || ![input, output, cached].every(n => Number.isSafeInteger(n) && n >= 0) || cached > input) {
            throw new LlmError('Codex reported invalid usage counts', 'CODEX_PROTOCOL')
          }
          usage = { inputTokens: input - cached, outputTokens: output, cacheReadTokens: cached, totalTokens: input + output }
        }
      }
      if (event.type === 'item.started' || event.type === 'item.completed') {
        const item = record(event.item)
        if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_tool_call'].includes(String(item.type))) {
          throw new LlmError('Codex attempted a native tool; DPH must execute all tools', 'CODEX_NATIVE_TOOL')
        }
        if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') finalText = item.text
      }
    }
    child.stdout.setEncoding('utf8')
    for await (const chunk of child.stdout) {
      const text = String(chunk)
      bytes += Buffer.byteLength(text)
      if (bytes > config.maxOutputBytes) throw new LlmError('Codex output exceeded the configured byte limit', 'CODEX_OUTPUT_LIMIT')
      buffered += text
      let boundary: number
      while ((boundary = buffered.indexOf('\n')) >= 0) {
        accept(buffered.slice(0, boundary))
        buffered = buffered.slice(boundary + 1)
      }
    }
    accept(buffered)
    const settled = await outcome
    signal.throwIfAborted()
    if ('error' in settled) {
      if ((settled.error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new LlmError('Codex CLI was not found; configure its executable path', 'CODEX_NOT_FOUND')
      throw new LlmError('Codex process could not start', 'CODEX_FAILED', { cause: settled.error })
    }
    if (settled.value.exitCode !== 0 || failure !== undefined) {
      throw cliError(failure ?? child.collected.stderr?.readFrom(0).text ?? '')
    }
    if (!completed || finalText === undefined) throw new LlmError('Codex exited without a completed response', 'CODEX_PROTOCOL')
    return { text: finalText, ...(usage === undefined ? {} : { usage }), exitCode: settled.value.exitCode }
  } finally {
    if (child !== undefined) {
      child.terminate()
      await child.done.catch(() => { /* A spawn error is reported by the invocation above. */ })
      await child.waitForExit()
    }
    for (const path of imagePaths) {
      await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    }
    await unlink(schema).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
    // Remove only an empty owned directory; never recurse into model-created paths.
    await rmdir(cwd).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error })
  }
}
