/** Codex structured responses project onto the existing DPH tool protocol. */
import { randomUUID } from 'node:crypto'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AttachmentId, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Stable transport instruction; the DPH request remains the task authority. */
export const BRIDGE_INSTRUCTION = 'You are the reasoning provider for DeepSeek Harness. The JSON request contains its system instructions, conversation and available tools. Continue that conversation. Images attached to this CLI prompt are numbered from 1; JSON image blocks preserve the owning message and name the matching image number. Return only the required JSON response. To use a tool, return its name and JSON-encoded arguments in toolCalls; Harness executes it and supplies the result in the next request. Do not execute tools yourself. Do not claim a requested tool has run until its result is present. Use text for your response and an empty toolCalls array when finished.'

/** Strict final response schema accepted by codex exec. */
export const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text', 'toolCalls'],
  properties: {
    text: { type: 'string' },
    toolCalls: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'arguments'],
      properties: { name: { type: 'string' }, arguments: { type: 'string' } },
    } },
  },
}

/** Remove credentials from diagnostic text before storing or presenting it.
 * @param text - untrusted CLI diagnostic.
 * @returns diagnostic with recognizable credential values removed.
 */
export function redact(text: string): string {
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|api[_-]?key|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
}

/** Serialize only logged provider-neutral content, excluding internal provenance.
 * @param options - assembled DPH request.
 * @returns task passed through stdin, never shell interpolation.
 */
export function serialize(options: GenerateOptions, images: readonly RequestImageAttachment[] = []): string {
  for (const key of ['temperature', 'maxTokens', 'stop'] as const) {
    if (options[key] !== undefined) throw new LlmError(`Codex CLI cannot honor ${key}`, 'UNSUPPORTED_OPTION')
  }
  const imageIndexes = new Map<AttachmentId, { image: RequestImageAttachment; index: number }>(
    images.map((image, index) => [image.attachment.attachmentId, { image, index: index + 1 }]),
  )
  const project = (blocks: ContentBlock[]): unknown[] => blocks.map(block => {
    switch (block.type) {
      case 'text': return { type: block.type, text: block.text }
      case 'reasoning': return { type: block.type, text: block.text }
      case 'image': {
        const entry = imageIndexes.get(block.attachment.attachmentId)
        if (entry === undefined) throw new LlmError(`Codex request image ${block.attachment.attachmentId} was not prepared.`, 'INVALID_REQUEST')
        return { type: block.type, image: entry.index, attachmentId: block.attachment.attachmentId,
          mediaType: entry.image.mediaType, width: entry.image.width, height: entry.image.height,
          ...(block.attachment.name === undefined ? {} : { name: block.attachment.name }) }
      }
      case 'tool-call': return { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
      case 'tool-result': return { type: block.type, toolCallId: block.toolCallId, content: project(block.content), isError: block.isError }
      default: throw new LlmError('Codex bridge cannot represent an unknown content block', 'UNSUPPORTED_CONTENT')
    }
  })
  return `${BRIDGE_INSTRUCTION}\n${JSON.stringify({
    system: options.system ?? '', tools: options.tools ?? [],
    messages: options.messages.map(message => ({ role: message.role, content: project(message.content) })),
  })}`
}

/** Parse a CLI JSON object at the process boundary.
 * @param value - decoded JSON value.
 * @returns object fields, rejecting primitives and arrays.
 */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LlmError('Codex returned a non-object response', 'CODEX_PROTOCOL')
  }
  return value as Record<string, unknown>
}

/** Validate a final response before exposing any tool calls.
 * @param text - JSON final answer.
 * @param options - request whose tool names authorize the response.
 * @param usage - authoritative CLI usage, when available.
 * @returns complete DPH chunk sequence.
 */
export function responseChunks(text: string, options: GenerateOptions, usage?: TokenUsage): StreamChunk[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new LlmError('Codex final response is not valid JSON', 'CODEX_PROTOCOL') }
  const data = record(raw)
  if (typeof data.text !== 'string' || !Array.isArray(data.toolCalls) || Object.keys(data).some(k => k !== 'text' && k !== 'toolCalls')) {
    throw new LlmError('Codex final response does not match the required schema', 'CODEX_PROTOCOL')
  }
  const allowed = new Set(options.tools?.map(tool => tool.name))
  const blocks: ContentBlock[] = []
  if (data.text.length) blocks.push({ type: 'text', text: data.text })
  for (const value of data.toolCalls) {
    const call = record(value)
    if (typeof call.name !== 'string' || !allowed.has(call.name) || typeof call.arguments !== 'string'
      || Object.keys(call).some(k => k !== 'name' && k !== 'arguments')) {
      throw new LlmError('Codex requested a tool outside this request', 'CODEX_PROTOCOL')
    }
    let args: unknown
    try { args = JSON.parse(call.arguments) } catch { throw new LlmError('Codex tool arguments are not JSON', 'CODEX_PROTOCOL') }
    record(args)
    blocks.push({ type: 'tool-call', id: ToolCallId(randomUUID()), name: call.name, arguments: call.arguments })
  }
  if (!blocks.length) throw new LlmError('Codex returned an empty response', 'CODEX_PROTOCOL')
  const chunks: StreamChunk[] = []
  blocks.forEach((block, index) => {
    chunks.push({ type: 'block-start', index, blockType: block.type })
    if (block.type === 'text') chunks.push({ type: 'text-delta', index, text: block.text })
    if (block.type === 'tool-call') chunks.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments })
    chunks.push({ type: 'block-end', index, block })
  })
  if (usage !== undefined) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'finish', reason: { kind: data.toolCalls.length ? 'tool-calls' : 'stop' } })
  return chunks
}

/** Classify diagnostic failures without exposing raw credential values.
 * @param diagnostic - captured CLI stderr or error event.
 * @returns stable DPH provider failure.
 */
export function cliError(diagnostic: string): LlmError {
  const message = redact(diagnostic).slice(-4000)
  if (/rate.limit|usage.limit|too many requests|quota|usage cap/i.test(message)) return new LlmError(message, 'RATE_LIMIT')
  if (/unauthorized|authentication|not logged|sign.in|login|401/i.test(message)) return new LlmError(message, 'CODEX_AUTH_REQUIRED')
  return new LlmError(message || 'Codex CLI failed', 'CODEX_FAILED')
}
