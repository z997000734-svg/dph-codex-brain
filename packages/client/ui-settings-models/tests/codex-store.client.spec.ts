import { describe, expect, it } from 'vitest'
import { CodexController } from '../src/client/codex-store.ts'
import type { CodexConfiguration, CodexOperations } from '../src/client/codex-store.ts'

const config: CodexConfiguration = { enabled: true, command: 'codex', model: 'default', proxyUrl: '', timeoutSeconds: 1800, graceMs: 3000, maxOutputBytes: 2097152, maxQueueSize: 100, retainedTasks: 100 }
function operations(): CodexOperations {
  return { configuration: async () => config, configure: async () => {}, status: async () => ({ enabled: true, paused: false, version: null, authentication: 'unknown', error: null, tasks: [] }), detect: async () => { throw new Error('CLI missing') }, test: async () => 'OK', pause: async () => {}, cancel: async () => true, setDefault: async () => {} }
}

describe('Codex management controller', () => {
  it('retains configuration and exposes failed saves', async () => {
    const ops = operations()
    ops.configure = async () => { throw new Error('Disk full') }
    const controller = new CodexController(ops)
    await controller.refresh()
    expect(await controller.act('save', { ...config, model: 'other' })).toBe(false)
    expect(controller.store.getSnapshot()).toMatchObject({ config, busy: false, error: 'Disk full' })
    controller.dispose()
  })

  it('allows cancellation during a connection test without clearing its busy state', async () => {
    const ops = operations()
    let finish!: (value: string) => void
    ops.test = () => new Promise(resolve => { finish = resolve })
    const controller = new CodexController(ops)
    const test = controller.act('test')
    expect(await controller.act('cancel', 'request')).toBe(true)
    expect(controller.store.getSnapshot().busy).toBe(true)
    expect(await controller.act('default')).toBe(false)
    finish('OK')
    expect(await test).toBe(true)
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, result: 'OK' })
    controller.dispose()
  })
})
