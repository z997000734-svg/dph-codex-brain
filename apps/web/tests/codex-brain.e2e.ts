/** Shipped Loader wiring: no installed CLI or network is required. */
import { afterEach, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-llm-codex'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold | undefined
afterEach(async () => { await scaffold?.close(); scaffold = undefined })

it('mounts Codex management and activates its provider through persisted settings', async () => {
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  const brain = scaffold.ctx.codexBrain
  expect(await brain.status()).toMatchObject({ enabled: false, tasks: [] })
  await brain.configure({ ...await brain.configuration(), enabled: true })
  expect(await brain.status()).toMatchObject({ enabled: true, paused: false })
  expect(scaffold.ctx.llm.providerRetryPolicy('codex')).toMatchObject({ maxRetries: 0 })
  await brain.setDefault()
  await brain.configure({ ...await brain.configuration(), enabled: false })
  expect(await brain.status()).toMatchObject({ enabled: false, paused: true })
})
