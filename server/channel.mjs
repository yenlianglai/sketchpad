// Sketch + voice channel for Claude Code.
//
// Claude Code spawns this file as an MCP server over stdio (see .mcp.json) and
// starts it with `--dangerously-load-development-channels server:sketch`.
// The same process serves the iPad web UI over HTTP(S) + WebSocket:
//
//   iPad Safari  --WS/HTTP-->  this server  --stdio notification-->  Claude Code session
//   iPad Safari  <--WS-------  this server  <--reply tool----------  Claude
//
// stdout is the MCP transport. Never console.log here; use log() (stderr).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { WebSocketServer } from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createHeadlessDriver } from './headless.mjs'
import { createSketchpad } from './sketchpad.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = join(ROOT, 'web')
const INBOX_DIR = join(ROOT, 'inbox')   // sketches from the iPad, read by Claude
const OUTBOX_DIR = join(ROOT, 'outbox') // files Claude sends back via reply
const CERT_DIR = join(ROOT, 'certs')
const PORT = Number(process.env.SKETCH_PORT ?? 8790)
const TOKEN = process.env.SKETCH_TOKEN ?? '' // optional shared secret: iPad passes ?token=...
// DRIVER: 'channel'  = MCP channel into the Claude Code session that spawned us (needs org channels policy)
//         'headless' = we spawn our own `claude -p` (subscription login is enough)
//         'none'     = web UI only; turns just land in inbox/
const argDriver = (process.argv.find(a => a.startsWith('--driver=')) || '').split('=')[1]
const DRIVER = argDriver || (process.argv.includes('--standalone') ? 'none' : process.env.SKETCH_DRIVER || 'channel')
const WORK_DIR = process.env.SKETCH_CWD ? resolve(process.env.SKETCH_CWD) : ROOT // repo Claude works in (headless)

for (const d of [INBOX_DIR, OUTBOX_DIR]) mkdirSync(d, { recursive: true })
const log = (...a) => console.error('[sketch]', ...a)

const INSTRUCTIONS = [
  'You are paired with a person drawing on an iPad and talking at the same time.',
  'Each turn carries what they SAID (speech transcript, may be rough) and a PNG of what they DREW at that moment.',
  'Always look at the drawing before answering; it usually carries the real intent and the speech disambiguates it.',
  'Keep replies short and spoken-friendly: they are read aloud on the iPad.',
  'A turn with no speech means they drew without speaking; respond to the drawing.'
].join('\n')

// ---------------------------------------------------------------- MCP side
const mcp = new Server(
  { name: 'sketch', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: INSTRUCTIONS + '\n' + [
      'Turns arrive as <channel source="sketch" turn_id="..." file_path="...">: the body is the speech, file_path is the PNG. Read the file_path image first.',
      'The person reads the iPad UI, not this terminal. Anything you want them to see MUST go through the `reply` tool; your transcript output never reaches them.',
      'To show something visual, write an image or SVG file and pass its path in `files`.'
    ].join('\n')
  }
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to the iPad UI. Optional files (absolute paths: png/jpg/svg/pdf/md) are shown inline.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Short, spoken-friendly message.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to show.' },
          turn_id: { type: 'string', description: 'The turn_id this replies to, if any.' }
        },
        required: ['text']
      }
    }
  ]
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  try {
    const { text = '', files = [], turn_id } = req.params.arguments ?? {}
    const out = []
    for (const f of files) {
      const st = statSync(f)
      if (st.size > 50 * 1024 * 1024) throw new Error(`file too large: ${f}`)
      const name = `${Date.now()}-${basename(f)}`
      copyFileSync(f, join(OUTBOX_DIR, name))
      out.push({ url: `/files/${name}`, name: basename(f) })
    }
    broadcast({ type: 'reply', id: randomUUID(), text, files: out, turnId: turn_id, ts: Date.now() })
    return { content: [{ type: 'text', text: 'sent' }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `reply failed: ${err.message}` }], isError: true }
  }
})

let mcpReady = false
let headless = null
function deliverTurn({ turnId, text, pngPath, pngBase64, strokes, durationMs }) {
  if (DRIVER === 'headless') {
    if (!headless?.alive()) { log('headless claude not running', turnId); return false }
    headless.sendTurn({ turnId, text, pngPath, pngBase64 })
    return true
  }
  const meta = { chat_id: 'ipad', turn_id: turnId }
  if (pngPath) meta.file_path = pngPath
  if (strokes != null) meta.strokes = String(strokes)
  if (durationMs != null) meta.speech_ms = String(durationMs)
  const content = text?.trim() || ''
  if (!mcpReady) { log('turn received but MCP not connected (standalone?)', turnId); return false }
  mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })
    .catch(err => log('notification failed', err.message))
  return true
}

// Headless driver: forward Claude's stream events to the iPad as replies / status lines.
function startHeadless() {
  headless = createHeadlessDriver({
    cwd: WORK_DIR, log,
    instructions: INSTRUCTIONS + '\nYour plain text output is forwarded to the iPad as-is; there is no reply tool. Do not search for one.',
    resume: process.env.SKETCH_RESUME,
    permissionMode: process.env.SKETCH_PERMISSION_MODE,
    onEvent: ev => {
      // system/init only arrives after the first user message, so it is informational here.
      if (ev.type === 'ready') broadcast({ type: 'mcp', ready: true, mode: 'headless', sessionId: ev.sessionId, model: ev.model })
      if (ev.type === 'text') broadcast({ type: 'reply', id: randomUUID(), text: ev.text, files: [], ts: Date.now() })
      if (ev.type === 'tool') {
        const detail = ev.input?.file_path ? basename(ev.input.file_path) : ev.input?.command ? String(ev.input.command).slice(0, 60) : ''
        broadcast({ type: 'sys', text: `⚙ ${ev.name} ${detail}`.trim() })
      }
      if (ev.type === 'result') {
        broadcast({ type: 'sys', text: ev.ok ? `✓ ${Math.round((ev.durationMs || 0) / 1000)}s · $${(ev.costUsd || 0).toFixed(3)}` : `✗ ${ev.error || 'turn failed'}` })
      }
      if (ev.type === 'exit') {
        mcpReady = false
        broadcast({ type: 'mcp', ready: false, mode: 'headless' })
      }
    }
  })
  // With stream-json input the process idles silently until the first turn; it is usable right away.
  mcpReady = headless.alive()
  broadcast({ type: 'mcp', ready: mcpReady, mode: 'headless' })
}

// ---------------------------------------------------------------- web side
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json'
}
const sockets = new Set()
function broadcast(msg) {
  const s = JSON.stringify(msg)
  for (const ws of sockets) if (ws.readyState === 1) ws.send(s)
}
function authorized(url) { return !TOKEN || url.searchParams.get('token') === TOKEN }

// Sketchpad-as-MCP: shared turn queue + tool set, served over Streamable HTTP at /mcp (stateless,
// one transport per request) so any agent — Claude Code, ADK, Codex — can pull turns.
const sketchpad = createSketchpad({ log, broadcast, clientCount: () => sockets.size })
async function handleMcp(req, res) {
  let body
  if (req.method === 'POST') {
    try { body = JSON.parse((await readBody(req)).toString('utf8')) } catch { return send(res, 400, 'invalid json') }
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = sketchpad.buildServer()
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}
function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = []
    req.on('data', c => chunks.push(c)); req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej)
  })
}
function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body)
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  if (!authorized(url)) return send(res, 401, 'bad token')
  try {
    if (url.pathname === '/mcp') return handleMcp(req, res)
    if (req.method === 'POST' && url.pathname === '/snapshot') {
      const body = JSON.parse((await readBody(req)).toString('utf8'))
      sketchpad.resolveSnapshot(body.id, body.png ? body.png.replace(/^data:image\/png;base64,/, '') : null)
      return send(res, 200, 'ok')
    }
    if (req.method === 'POST' && url.pathname === '/turn') {
      // { text, png: dataURL|null, strokes, durationMs }
      const body = JSON.parse((await readBody(req)).toString('utf8'))
      const turnId = randomUUID().slice(0, 8)
      let pngPath = null, b64 = null
      if (body.png) {
        b64 = body.png.replace(/^data:image\/png;base64,/, '')
        pngPath = join(INBOX_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${turnId}.png`)
        writeFileSync(pngPath, Buffer.from(b64, 'base64'))
      }
      // Always queue for MCP pullers; the push drivers (channel/headless) are additive.
      sketchpad.pushTurn({ turnId, text: body.text, pngPath, pngBase64: b64, strokes: body.strokes, durationMs: body.durationMs, ts: Date.now() })
      const delivered = DRIVER === 'none' ? true : deliverTurn({ turnId, text: body.text, pngPath, pngBase64: b64, strokes: body.strokes, durationMs: body.durationMs })
      log(`turn ${turnId}: "${(body.text || '').slice(0, 60)}" png=${pngPath ? basename(pngPath) : '-'} delivered=${delivered}`)
      broadcast({ type: 'turn', turnId, text: body.text, pngPath, delivered, ts: Date.now() })
      return send(res, 200, JSON.stringify({ turnId, pngPath, delivered }), 'application/json')
    }
    if (url.pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, driver: DRIVER, mcp: mcpReady, clients: sockets.size, pending_turns: sketchpad.pending() }), 'application/json')
    }
    if (url.pathname.startsWith('/files/')) {
      const f = basename(url.pathname)
      const p = join(OUTBOX_DIR, f)
      if (!existsSync(p)) return send(res, 404, 'not found')
      return send(res, 200, readFileSync(p), MIME[extname(f).toLowerCase()] ?? 'application/octet-stream')
    }
    let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    file = basename(file) // flat web dir, no traversal
    const p = join(WEB_DIR, file)
    if (!existsSync(p)) return send(res, 404, 'not found')
    return send(res, 200, readFileSync(p), MIME[extname(p).toLowerCase()] ?? 'application/octet-stream')
  } catch (err) {
    log('http error', err.message)
    return send(res, 500, err.message)
  }
}

const tls = !process.env.SKETCH_NO_TLS && existsSync(join(CERT_DIR, 'server.key')) && existsSync(join(CERT_DIR, 'server.crt'))
const HOST_HINT = process.env.SKETCH_HOST || lanIp()
function lanIp() {
  for (const addrs of Object.values(networkInterfaces()))
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) return a.address
  return 'localhost'
}
const httpServer = tls
  ? createHttpsServer({ key: readFileSync(join(CERT_DIR, 'server.key')), cert: readFileSync(join(CERT_DIR, 'server.crt')) }, handle)
  : createHttpServer(handle)

const wss = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/ws' || !authorized(url)) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, ws => {
    sockets.add(ws)
    ws.send(JSON.stringify({ type: 'hello', mcp: mcpReady, tls, mode: DRIVER, sessionId: headless?.sessionId }))
    ws.on('close', () => sockets.delete(ws))
  })
})

// Plain http on PORT+1: the MCP endpoint for agents on this machine (http://localhost:PORT+1/mcp),
// and, when TLS is on, the certificate so the iPad can install it straight from Safari.
{
  const certPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install certificate</title>
<style>body{font:17px/1.5 -apple-system,system-ui;max-width:560px;margin:40px auto;padding:0 20px;color:#1a1a1a}
a.btn{display:block;text-align:center;background:#1a1a1a;color:#fff;padding:14px;border-radius:12px;text-decoration:none;font-weight:600;margin:20px 0}
ol li{margin:8px 0}code{background:#eee;padding:2px 6px;border-radius:4px}</style>
<h1>Sketch + Voice 憑證安裝</h1>
<a class="btn" href="/sketchpad.crt">1. 下載憑證</a>
<ol>
<li>Safari 會問「是否允許下載設定描述檔」→ <b>允許</b></li>
<li>設定 › 一般 › VPN 與裝置管理 › <b>已下載的描述檔</b> › 安裝</li>
<li>設定 › 一般 › 關於本機 › <b>憑證信任設定</b> › 把 <code>sketchpad</code> 開啟</li>
<li>回 Safari 開 <a href="https://${HOST_HINT}:${PORT}/${TOKEN ? '?token=…' : ''}">https://${HOST_HINT}:${PORT}/</a></li>
</ol>`
  createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/mcp') {
      if (!authorized(url)) return send(res, 401, 'bad token')
      return handleMcp(req, res).catch(err => { log('mcp error', err.message); if (!res.headersSent) send(res, 500, err.message) })
    }
    if (tls && url.pathname.startsWith('/sketchpad.crt')) {
      res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="sketchpad.crt"' })
      return res.end(readFileSync(join(CERT_DIR, 'server.crt')))
    }
    if (!tls) return send(res, 200, `sketchpad MCP endpoint: /mcp\nweb UI: http://${HOST_HINT}:${PORT}/ (no TLS; run npm run cert for iPad mic)`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(certPage)
  }).listen(PORT + 1, '0.0.0.0', () => {
    log(`MCP endpoint (Streamable HTTP): http://localhost:${PORT + 1}/mcp${TOKEN ? '?token=***' : ''}`)
    if (tls) log(`cert install page on http://${HOST_HINT}:${PORT + 1}/  (open this on the iPad first)`)
  })
}

httpServer.listen(PORT, '0.0.0.0', () => {
  log(`web UI on ${tls ? 'https' : 'http'}://0.0.0.0:${PORT}${TOKEN ? '/?token=***' : ''}  (tls=${tls}, driver=${DRIVER}, cwd=${WORK_DIR})`)
  if (!tls) log('no certs/ found: iPad Safari will refuse the microphone over plain http. Run: npm run cert')
})

if (DRIVER === 'channel') {
  await mcp.connect(new StdioServerTransport())
  mcpReady = true
  broadcast({ type: 'mcp', ready: true, mode: 'channel' })
  log('MCP connected to Claude Code')
} else if (DRIVER === 'headless') {
  startHeadless()
  process.on('SIGINT', () => { headless?.close(); setTimeout(() => process.exit(0), 2500) })
}
