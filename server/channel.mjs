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
import { WebSocketServer } from 'ws'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = join(ROOT, 'web')
const INBOX_DIR = join(ROOT, 'inbox')   // sketches from the iPad, read by Claude
const OUTBOX_DIR = join(ROOT, 'outbox') // files Claude sends back via reply
const CERT_DIR = join(ROOT, 'certs')
const PORT = Number(process.env.SKETCH_PORT ?? 8790)
const TOKEN = process.env.SKETCH_TOKEN ?? '' // optional shared secret: iPad passes ?token=...
const STANDALONE = process.argv.includes('--standalone') // run web UI without Claude Code

for (const d of [INBOX_DIR, OUTBOX_DIR]) mkdirSync(d, { recursive: true })
const log = (...a) => console.error('[sketch]', ...a)

// ---------------------------------------------------------------- MCP side
const mcp = new Server(
  { name: 'sketch', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'You are paired with a person drawing on an iPad and talking at the same time.',
      'Each turn arrives as <channel source="sketch" turn_id="..." file_path="...">: the body is what they SAID (speech transcript, may be rough),',
      'and file_path is a PNG of what they DREW at that moment. Always Read the file_path image before answering; the drawing usually carries the real intent and the speech disambiguates it.',
      'The person reads the iPad UI, not this terminal. Anything you want them to see MUST go through the `reply` tool; your transcript output never reaches them.',
      'Keep replies short and spoken-friendly. To show something visual, write an image or SVG file and pass its path in `files`.',
      'A turn with an empty body means they drew without speaking; respond to the drawing.'
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
function deliverTurn({ turnId, text, pngPath, strokes, durationMs }) {
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
    if (req.method === 'POST' && url.pathname === '/turn') {
      // { text, png: dataURL|null, strokes, durationMs }
      const body = JSON.parse((await readBody(req)).toString('utf8'))
      const turnId = randomUUID().slice(0, 8)
      let pngPath = null
      if (body.png) {
        const b64 = body.png.replace(/^data:image\/png;base64,/, '')
        pngPath = join(INBOX_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${turnId}.png`)
        writeFileSync(pngPath, Buffer.from(b64, 'base64'))
      }
      const delivered = deliverTurn({ turnId, text: body.text, pngPath, strokes: body.strokes, durationMs: body.durationMs })
      log(`turn ${turnId}: "${(body.text || '').slice(0, 60)}" png=${pngPath ? basename(pngPath) : '-'} delivered=${delivered}`)
      broadcast({ type: 'turn', turnId, text: body.text, pngPath, delivered, ts: Date.now() })
      return send(res, 200, JSON.stringify({ turnId, pngPath, delivered }), 'application/json')
    }
    if (url.pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, mcp: mcpReady, clients: sockets.size }), 'application/json')
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

const tls = existsSync(join(CERT_DIR, 'server.key')) && existsSync(join(CERT_DIR, 'server.crt'))
const httpServer = tls
  ? createHttpsServer({ key: readFileSync(join(CERT_DIR, 'server.key')), cert: readFileSync(join(CERT_DIR, 'server.crt')) }, handle)
  : createHttpServer(handle)

const wss = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/ws' || !authorized(url)) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, ws => {
    sockets.add(ws)
    ws.send(JSON.stringify({ type: 'hello', mcp: mcpReady, tls }))
    ws.on('close', () => sockets.delete(ws))
  })
})

httpServer.listen(PORT, '0.0.0.0', () => {
  log(`web UI on ${tls ? 'https' : 'http'}://0.0.0.0:${PORT}${TOKEN ? '/?token=***' : ''}  (tls=${tls}, standalone=${STANDALONE})`)
  if (!tls) log('no certs/ found: iPad Safari will refuse the microphone over plain http. Run: npm run cert')
})

if (!STANDALONE) {
  await mcp.connect(new StdioServerTransport())
  mcpReady = true
  broadcast({ type: 'mcp', ready: true })
  log('MCP connected to Claude Code')
}
