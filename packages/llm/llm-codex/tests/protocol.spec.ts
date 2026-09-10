/** Request projection and hostile process-output regression tests. */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { resolveConfig } from '../src/config.ts'
import { argvFor } from '../src/process.ts'
import { cliError, redact, responseChunks, serialize } from '../src/protocol.ts'

const request: GenerateOptions = { provider: 'codex', model: 'default',
  messages: [createUserMessage({ content: [{ type: 'text', text: '检查项目' }], source: { kind: 'user' } })],
  tools: [{ name: 'read_file', description: 'Read a workspace file', parameters: { type: 'object' } }],
}
const imageRef: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 2, height: 1, name: 'chart.png' }
const image: RequestImageAttachment = { variantId: ImageVariantId('variant'), attachment: imageRef, data: Uint8Array.from([1, 2, 3]),
  mediaType: 'image/png', bytes: 3, width: 2, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true }

describe('Codex response bridge', () => {
  it('returns a DPH tool request and continues only after a DPH result', () => {
    const chunks = responseChunks(JSON.stringify({ text: '', toolCalls: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }] }), request)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks.find(c => c.type === 'block-end')).toMatchObject({ block: { type: 'tool-call', name: 'read_file', arguments: '{"path":"a.ts"}' } })
  })
  it.each([
    'not JSON', '{"text":"OK","toolCalls":[{"name":"shell","arguments":"{}"}]}',
    '{"text":"OK","toolCalls":[{"name":"read_file","arguments":"null"}]}',
    '{"text":"OK","toolCalls":[{"name":"read_file","arguments":"oops"}]}',
    '{"text":"","toolCalls":[]}',
  ])('rejects malformed or unauthorized output before emitting chunks: %s', text => {
    expect(() => responseChunks(text, request)).toThrow()
  })
  it('puts usage before finish and keeps multilingual text', () => {
    const chunks = responseChunks('{"text":"完成","toolCalls":[]}', request, { inputTokens: 1, outputTokens: 2 })
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('excludes internal message provenance and rejects unsupported options', () => {
    expect(serialize(request)).toContain('检查项目')
    expect(serialize(request)).not.toContain(request.messages[0]!.id)
    expect(() => serialize({ ...request, temperature: 0 })).toThrow('temperature')
  })
  it('binds image blocks to ordered CLI attachments without embedding bytes', () => {
    const withImage = { ...request, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: imageRef }] })] }
    const serialized = serialize(withImage, [image])
    expect(serialized).toContain('"image":1')
    expect(serialized).toContain('"name":"chart.png"')
    expect(serialized).not.toContain(Buffer.from(image.data).toString('base64'))
    expect(() => serialize(withImage)).toThrow('was not prepared')
  })
  it('never shell-interpolates prompts or reuses the user session', () => {
    const argv = argvFor(resolveConfig({}), 'D:/private schema.json', request, ['D:/private image.png'])
    expect(argv).toContain('--ignore-user-config')
    expect(argv).toContain('--ephemeral')
    expect(argv).toContain('forced_login_method="chatgpt"')
    expect(argv).not.toContain('resume')
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argv).toContain('--image')
    expect(argv).toContain('D:/private image.png')
    expect(argv.at(-1)).toBe('-')
  })
  it('redacts credentials and classifies limit and authentication failures', () => {
    expect(redact('Bearer abc access_token=secret sk-123ABC')).toBe('Bearer [REDACTED] access_token=[REDACTED] [REDACTED]')
    expect(cliError('usage limit reached').code).toBe('RATE_LIMIT')
    expect(cliError('Please sign in').code).toBe('CODEX_AUTH_REQUIRED')
  })
})
