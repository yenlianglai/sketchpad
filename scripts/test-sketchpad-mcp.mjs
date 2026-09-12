// Drives the Sketchpad MCP endpoint the way any agent would (Streamable HTTP client):
// list tools → wait_for_turn while an "iPad" posts a turn → assert text + image block →
// show a reply and confirm the iPad WebSocket receives it.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 8794
const server = spawn('node', ['server/channel.mjs', '--driver=none'], { env: { ...process.env, SKETCH_PORT: String(PORT), SKETCH_NO_TLS: '1' }, stdio: ['ignore', 'ignore', 'inherit'] })
const stop = code => { server.kill('SIGINT'); setTimeout(() => process.exit(code), 500) }
await new Promise(r => setTimeout(r, 800))

// pretend to be the iPad
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
const wsMsgs = []
ws.on('message', d => wsMsgs.push(JSON.parse(d.toString())))
await new Promise(r => ws.on('open', r))

const client = new Client({ name: 'test-agent', version: '0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT + 1}/mcp`)))
const tools = (await client.listTools()).tools.map(t => t.name)
console.log('tools:', tools)
if (!tools.includes('sketchpad_wait_for_turn')) { console.error('missing tool'); stop(1) }

console.log('status:', (await client.callTool({ name: 'sketchpad_status', arguments: {} })).content[0].text)

// agent starts waiting, iPad sends a turn 500ms later
const png = 'data:image/png;base64,' + readFileSync(new URL('./fixtures/box.png', import.meta.url)).toString('base64')
const waiting = client.callTool({ name: 'sketchpad_wait_for_turn', arguments: { timeout_seconds: 10 } })
setTimeout(() => fetch(`http://127.0.0.1:${PORT}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '把這個變成登入表單', png, strokes: 4, durationMs: 2000 }) }), 500)
const t0 = Date.now()
const turn = await waiting
console.log(`wait_for_turn returned after ${Date.now() - t0}ms:`)
console.log(' ', turn.content[0].text.split('\n').join('\n  '))
const img = turn.content.find(c => c.type === 'image')
console.log('  image block:', img ? `${img.mimeType}, ${Math.round(img.data.length * 3 / 4 / 1024)} KB` : 'MISSING')
if (!img) stop(1)

// no-turn path
const empty = await client.callTool({ name: 'sketchpad_wait_for_turn', arguments: { timeout_seconds: 1 } })
console.log('empty wait:', empty.content[0].text)

// get_canvas: iPad answers the snapshot request
ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'snapshot_request') fetch(`http://127.0.0.1:${PORT}/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: m.id, png }) }) })
const snap = await client.callTool({ name: 'sketchpad_get_canvas', arguments: {} })
console.log('get_canvas:', snap.content.find(c => c.type === 'image') ? 'image ok' : 'FAILED ' + snap.content[0].text)

// show → iPad
await client.callTool({ name: 'sketchpad_show', arguments: { text: '好，帳號、密碼、登入鈕。', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="10" y="10" width="180" height="100" fill="none" stroke="#c8552b" stroke-width="3"/></svg>' } })
await new Promise(r => setTimeout(r, 300))
const reply = wsMsgs.find(m => m.type === 'reply')
console.log('iPad got reply:', reply ? `${reply.text} (+${reply.files.length} file)` : 'MISSING')
console.log('iPad saw taken:', wsMsgs.some(m => m.type === 'taken'))

await client.close(); ws.close()
console.log(reply && img ? 'OK' : 'FAILED')
stop(reply && img ? 0 : 1)
