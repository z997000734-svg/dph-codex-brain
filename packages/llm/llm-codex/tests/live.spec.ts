/** Opt-in real official CLI smoke; credentials are never read by this test. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { executeCli } from '../src/process.ts'
import { responseChunks, serialize } from '../src/protocol.ts'

it.skipIf(process.env.CODEX_BRAIN_E2E !== '1')('uses the official CLI for a real DPH response', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  const root = await mkdtemp(join(tmpdir(), 'dph-codex-live-'))
  try {
    const options = { provider: 'codex', model: 'default', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text' as const, text: 'Reply exactly OK.' }] })] }
    const result = await executeCli(ctx.subprocess, root, resolveConfig({ enabled: true, proxyUrl: process.env.CODEX_BRAIN_TEST_PROXY ?? '' }), options, serialize(options), AbortSignal.timeout(120000), () => {})
    expect(responseChunks(result.text, options, result.usage)).toContainEqual({ type: 'text-delta', index: 0, text: 'OK' })
  } finally {
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 150000)
