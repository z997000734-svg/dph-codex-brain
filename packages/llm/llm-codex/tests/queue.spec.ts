/** Real child processes exercise serialization, cancellation and restart records. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { CodexQueue } from '../src/queue.ts'
import { executeCli } from '../src/process.ts'

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))
class FixtureProcess extends LocalSubprocessRuntime {
  count = 0
  peak = 0
  lastArgv: readonly string[] = []
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.lastArgv = [...spec.argv]
    const child = super.spawn({ ...spec, argv: [process.execPath, fixture, ...spec.argv.slice(1)] })
    this.count++; this.peak = Math.max(this.peak, this.count)
    void child.done.finally(() => { this.count-- }).catch(() => {})
    return child
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(timeoutSeconds = 30, attachments?: AttachmentStore): Promise<{ queue: CodexQueue; process: FixtureProcess; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dph-codex-queue-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(FixtureProcess)
  const subprocess = ctx.subprocess as FixtureProcess
  const queue = new CodexQueue(subprocess, root, () => resolveConfig({ enabled: true, timeoutSeconds }), () => attachments)
  cleanups.push(async () => { await queue.dispose(); await fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { queue, process: subprocess, root }
}

function request(text: string, signal?: AbortSignal) {
  return { provider: 'codex', model: 'default', ...(signal ? { signal } : {}),
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text' as const, text }] })] }
}

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'pixel.png',
}
const preparedImage: RequestImageAttachment = {
  variantId: ImageVariantId('test-variant'), attachment: imageRef, data: Uint8Array.from([1, 2, 3, 4]),
  mediaType: 'image/png', bytes: 4, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true,
}
const imageStore = { readImageRequest: async () => preparedImage } as unknown as AttachmentStore

describe('Codex queue ownership', () => {
  it('projects durable images into private CLI files and removes them after completion', async () => {
    const { queue, process, root } = await setup(30, imageStore)
    await queue.run({ provider: 'codex', model: 'default', messages: [createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'inspect image' }, { type: 'image', attachment: imageRef }] })] })
    expect(process.lastArgv).toContain('--image')
    expect(process.lastArgv.find(value => value.endsWith('image-001.png'))).toBeDefined()
    await expect(readdir(root)).resolves.toEqual(['tasks.json'])
  })
  it('marks crash records interrupted without resuming or killing their old PID', async () => {
    const { queue, process: subprocess, root } = await setup()
    await queue.run(request('OK'))
    const records = await queue.list()
    await writeFile(join(root, 'tasks.json'), JSON.stringify(records.map(view => ({ ...view, status: 'running', pid: 12345 }))))
    const restored = new CodexQueue(subprocess, root, () => resolveConfig({ enabled: true }))
    try {
      expect(await restored.list()).toMatchObject([{ status: 'interrupted', pid: null }])
      expect(subprocess.count).toBe(0)
      expect(await readFile(join(root, 'tasks.json'), 'utf8')).toContain('interrupted')
    } finally { await restored.dispose() }
  })
  it('executes three requests serially and stores bounded credential-free status', async () => {
    const { queue, process, root } = await setup()
    const first = queue.run(request('DELAY'))
    const second = queue.run(request('DELAY'))
    const third = queue.run(request('done'))
    await Promise.all([first, second, third])
    expect(process.peak).toBe(1)
    expect((await queue.list()).map(t => t.status)).toEqual(['completed', 'completed', 'completed'])
    expect(await readFile(join(root, 'tasks.json'), 'utf8')).not.toContain('DELAY')
  })
  it('removes a cancelled queued request without starting its process', async () => {
    const { queue, process } = await setup()
    queue.setPaused(true)
    const abort = new AbortController()
    const result = queue.run(request('HANG', abort.signal)).catch(error => error.code)
    await expect.poll(async () => (await queue.list()).length).toBe(1)
    abort.abort()
    expect(await result).toBe('ABORTED')
    expect(process.peak).toBe(0)
    expect((await queue.list())[0]!.status).toBe('cancelled')
  })
  it('terminates its active process and allows the next queued request to complete', async () => {
    const { queue, process } = await setup()
    const abort = new AbortController()
    const first = queue.run(request('HANG', abort.signal)).catch(error => error.code)
    await expect.poll(async () => (await queue.list())[0]?.status).toBe('running')
    const second = queue.run(request('done'))
    abort.abort()
    expect(await first).toBe('ABORTED')
    await second
    expect(process.count).toBe(0)
    expect(process.peak).toBe(1)
  })
  it('reports timeout separately from process exit and keeps the queue usable', async () => {
    const { queue, process } = await setup(1)
    await expect(queue.run(request('HANG'))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect((await queue.list())[0]!.status).toBe('timeout')
    expect(process.count).toBe(0)
    await queue.run(request('done'))
  })
  it('pauses after a usage limit and retains subsequent queued requests', async () => {
    const { queue } = await setup()
    await expect(queue.run(request('FAIL_LIMIT'))).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(queue.paused).toBe(true)
    const next = queue.run(request('done'))
    await expect.poll(async () => (await queue.list()).at(-1)?.status).toBe('queued')
    queue.setPaused(false)
    await next
  })
  it('redacts authentication errors and rejects native tool activity', async () => {
    const { queue } = await setup()
    await expect(queue.run(request('FAIL_AUTH'))).rejects.toMatchObject({ code: 'CODEX_AUTH_REQUIRED' })
    expect((await queue.list())[0]!.error).not.toContain('test-secret')
    await expect(queue.run(request('NATIVE_TOOL'))).rejects.toMatchObject({ code: 'CODEX_NATIVE_TOOL' })
  })
  it('cancelling a DPH request leaves a separately owned process alive', async () => {
    const { queue } = await setup()
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const unrelated = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), graceMs: 100,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } } })
    let ended = false
    void unrelated.done.then(() => { ended = true })
    try {
      const abort = new AbortController()
      const result = queue.run(request('HANG', abort.signal)).catch(() => {})
      await expect.poll(async () => (await queue.list())[0]?.status).toBe('running')
      abort.abort(); await result
      expect(ended).toBe(false)
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow()
    } finally { unrelated.terminate(); await unrelated.done; await fiber.dispose() }
  })
  it('reports an absent executable as CODEX_NOT_FOUND', async () => {
    const { root } = await setup()
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    try {
      await expect(executeCli(ctx.subprocess, root, resolveConfig({ command: 'nonexistent-dph-codex-executable' }),
        { model: 'default' }, 'OK', AbortSignal.timeout(10000), () => {})).rejects.toMatchObject({ code: 'CODEX_NOT_FOUND' })
    } finally { await fiber.dispose() }
  })
})
