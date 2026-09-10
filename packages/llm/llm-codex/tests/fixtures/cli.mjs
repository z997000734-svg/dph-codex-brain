// Deterministic external CLI substitute; only tests launch this executable.
import { readFile } from 'node:fs/promises'

const imagePaths = process.argv.flatMap((value, index, argv) => value === '--image' ? [argv[index + 1]] : []).filter(Boolean)
for (const path of imagePaths) {
  const bytes = await readFile(path)
  if (bytes.byteLength === 0) throw new Error('empty CLI image fixture')
}
let input = ''
for await (const chunk of process.stdin) input += chunk
if (input.includes('FAIL_AUTH')) { console.error('Please sign in. Bearer test-secret'); process.exit(1) }
if (input.includes('FAIL_LIMIT')) { console.error('usage limit reached'); process.exit(1) }
if (input.includes('HANG')) { await new Promise(resolve => setTimeout(resolve, 60000)) }
if (input.includes('DELAY')) await new Promise(resolve => setTimeout(resolve, 250))
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test-thread' }))
if (input.includes('NATIVE_TOOL')) console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }))
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ text: '完成', toolCalls: [] }) } }))
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 } }))
