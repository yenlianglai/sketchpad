// Drives server/channel.mjs as an MCP client the way Claude Code would, then
// POSTs a fake iPad turn and asserts the channel notification arrives.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

const PORT = 8791
const transport = new StdioClientTransport({
  command: 'node', args: ['server/channel.mjs'], env: { ...process.env, SKETCH_PORT: String(PORT) }, stderr: 'pipe'
})
transport.stderr?.on('data', d => process.stderr.write(d))
const client = new Client({ name: 'test', version: '0' }, { capabilities: { experimental: { 'claude/channel': {} } } })

const got = new Promise(res => {
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string()).optional() }) }),
    n => res(n.params)
  )
})
await client.connect(transport)
const tools = await client.listTools()
console.log('tools:', tools.tools.map(t => t.name))
await new Promise(r => setTimeout(r, 300))

// 1x1 red PNG
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const r = await fetch(`http://127.0.0.1:${PORT}/turn`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '把這個框框變成登入表單', png, strokes: 12, durationMs: 2100 })
})
console.log('POST /turn ->', r.status, await r.json())

const n = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no notification within 3s')), 3000))])
console.log('channel notification:', n)
if (!n.meta?.file_path || n.content !== '把這個框框變成登入表單') throw new Error('unexpected notification payload')

const reply = await client.callTool({ name: 'reply', arguments: { text: '好，我看到一個矩形。', files: [n.meta.file_path], turn_id: n.meta.turn_id } })
console.log('reply tool ->', reply.content[0].text)
console.log('OK')
await client.close()
process.exit(0)
