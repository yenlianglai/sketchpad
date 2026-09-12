// End-to-end check of the headless driver against a real `claude`:
// start the server with --driver=headless, wait until Claude is ready,
// POST one turn (speech + a sketch PNG), and print what comes back over WebSocket.
// Uses your claude.ai login; costs one small model call.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import WebSocket from 'ws'

const PORT = 8792
const sketch = process.argv[2] // optional path to a PNG; defaults to a drawn box
const png = sketch && existsSync(sketch)
  ? 'data:image/png;base64,' + readFileSync(sketch).toString('base64')
  : 'data:image/png;base64,' + readFileSync(new URL('./fixtures/box.png', import.meta.url)).toString('base64')

const server = spawn('node', ['server/channel.mjs', '--driver=headless'], { env: { ...process.env, SKETCH_PORT: String(PORT) }, stdio: ['ignore', 'inherit', 'inherit'] })
const done = () => { server.kill('SIGINT'); setTimeout(() => process.exit(0), 3000) }
process.on('SIGINT', done)

await new Promise(r => setTimeout(r, 800))
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
let sent = false
const timeout = setTimeout(() => { console.error('TIMEOUT: no result within 120s'); server.kill('SIGINT'); process.exit(1) }, 120_000)

ws.on('message', async raw => {
  const m = JSON.parse(raw.toString())
  if ((m.type === 'hello' && m.mcp) || (m.type === 'mcp' && m.ready)) {
    if (sent) return
    sent = true
    console.log(`claude ready (${m.model ?? 'model?'}), sending turn…`)
    const r = await fetch(`http://127.0.0.1:${PORT}/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '這個框框我想做成登入表單，你覺得裡面要放什麼？一句話就好', png, strokes: 4, durationMs: 3000 })
    })
    console.log('POST /turn ->', r.status, (await r.json()).turnId)
  }
  if (m.type === 'reply') console.log('REPLY:', m.text)
  if (m.type === 'sys') {
    console.log('sys:', m.text)
    if (m.text.startsWith('✓') || m.text.startsWith('✗')) { clearTimeout(timeout); console.log(m.text.startsWith('✓') ? 'OK' : 'FAILED'); done() }
  }
})
ws.on('error', e => { console.error('ws error', e.message); done() })
