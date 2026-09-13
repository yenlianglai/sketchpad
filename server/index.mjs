// Sketchpad server: the single process the iPad and your agent both talk to.
//
//   iPad  ──POST /turn (page PNG)──▶  server  ──MCP /mcp──▶  agent
//   iPad  ◀──── WebSocket /ws ─────  server  ◀───────────
//
// It holds the turn queue, the reply history, and the files the agent hands over. Agents reach it
// over Streamable HTTP at /mcp, or over stdio through server/mcp-stdio.mjs, which proxies to here.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { networkInterfaces, hostname } from 'node:os'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import qrcode from 'qrcode-terminal'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createSketchpad } from './sketchpad.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INBOX_DIR = join(ROOT, 'inbox')    // pages the iPad sent, as PNGs
const OUTBOX_DIR = join(ROOT, 'outbox')  // files the agent handed over, served at /files/
const PORT = Number(process.env.SKETCHPAD_PORT ?? 8791)
const TOKEN = process.env.SKETCHPAD_TOKEN ?? ''
const HOST_HINT = process.env.SKETCHPAD_HOST || lanIP()

for (const d of [INBOX_DIR, OUTBOX_DIR]) mkdirSync(d, { recursive: true })
const log = (...a) => console.error('[sketchpad]', ...a)

function lanIP() {
  for (const addrs of Object.values(networkInterfaces()))
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) return a.address
  return 'localhost'
}

// ---------------------------------------------------------------- iPad connections
const sockets = new Set()
function broadcast(msg) {
  const s = JSON.stringify(msg)
  for (const ws of sockets) if (ws.readyState === 1) ws.send(s)
}

const sketchpad = createSketchpad({ log, broadcast, clientCount: () => sockets.size, inboxDir: INBOX_DIR, outboxDir: OUTBOX_DIR })

// ---------------------------------------------------------------- http
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json'
}
const authorized = url => !TOKEN || url.searchParams.get('token') === TOKEN
const readBody = req => new Promise((res, rej) => {
  const chunks = []
  req.on('data', c => chunks.push(c)); req.on('end', () => res(Buffer.concat(chunks))); req.on('error', rej)
})
function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/// Stateless Streamable HTTP: one MCP transport per request, all sharing this process's state.
async function handleMCP(req, res) {
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  if (!authorized(url)) return send(res, 401, 'bad token')
  try {
    switch (true) {
      case url.pathname === '/mcp':
        return handleMCP(req, res)

      // The iPad sends a page: strokes rendered to PNG, plus whatever it wrote as a note.
      case req.method === 'POST' && url.pathname === '/turn': {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const turnId = randomUUID().slice(0, 8)
        let pngPath = null, b64 = null
        if (body.png) {
          b64 = body.png.replace(/^data:image\/png;base64,/, '')
          pngPath = join(INBOX_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${turnId}.png`)
          writeFileSync(pngPath, Buffer.from(b64, 'base64'))
        }
        sketchpad.pushTurn({ turnId, text: body.text, pngPath, pngBase64: b64, strokes: body.strokes, boardId: body.boardId, boardTitle: body.boardTitle, ts: Date.now() })
        log(`turn ${turnId}  "${(body.text || '').slice(0, 40)}"  ${body.strokes ?? '?'} new strokes`)
        broadcast({ type: 'turn', turnId, ts: Date.now() })
        return send(res, 200, JSON.stringify({ turnId, pngPath, delivered: true }), 'application/json')
      }

      // Answer to sketchpad_get_canvas.
      case req.method === 'POST' && url.pathname === '/snapshot': {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        sketchpad.resolveSnapshot(body.id, body.png ? body.png.replace(/^data:image\/png;base64,/, '') : null)
        return send(res, 200, 'ok')
      }

      // What the iPad missed while it was disconnected.
      case url.pathname === '/replies':
        return send(res, 200, JSON.stringify(sketchpad.recentReplies(Number(url.searchParams.get('since') || 0))), 'application/json')

      case url.pathname === '/pair':
        return send(res, 200, JSON.stringify({ host: `${HOST_HINT}:${PORT}`, token: TOKEN || null, url: pairingURL() }), 'application/json')

      case url.pathname === '/health':
        return send(res, 200, JSON.stringify({ ok: true, clients: sockets.size, pending_turns: sketchpad.pending(), agent_listening: sketchpad.isListening() }), 'application/json')

      // Files the agent handed over, fetched by the iPad.
      case url.pathname.startsWith('/files/'): {
        const f = basename(url.pathname)
        const p = join(OUTBOX_DIR, f)
        if (!existsSync(p)) return send(res, 404, 'not found')
        return send(res, 200, readFileSync(p), MIME[extname(f).toLowerCase()] ?? 'application/octet-stream')
      }

      default:
        return send(res, 200, `Sketchpad is running.\n\nMCP endpoint: /mcp\nPair an iPad:  ${pairingURL()}\n`)
    }
  } catch (err) {
    log('request failed:', err.message)
    return send(res, 500, err.message)
  }
}

const server = createServer(handle)

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname !== '/ws' || !authorized(url)) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, ws => {
    sockets.add(ws)
    ws.send(JSON.stringify({ type: 'hello', listening: sketchpad.isListening() }))
    ws.on('close', () => sockets.delete(ws))
  })
})

// The MCP url your agent registered carries this port, so never move it silently.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${PORT} is already in use — another Sketchpad is probably running.`)
    log(`  check:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`)
  } else {
    log(`cannot listen on ${PORT}: ${err.message}`)
  }
  process.exit(1)
})

server.listen(PORT, '0.0.0.0', () => {
  printPairing()
  advertiseBonjour()
})

// ---------------------------------------------------------------- pairing
function pairingURL() {
  return `sketchpad://pair?host=${HOST_HINT}:${PORT}` + (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '')
}

/// The iPad normally finds this Mac by itself. The QR is for networks that block Bonjour, and is
/// the quickest way to hand over a token.
function printPairing() {
  const out = s => process.stderr.write(s + '\n')
  out('')
  out('  iPad    open Sketchpad — it finds this computer on the network. Or scan:')
  out('')
  qrcode.generate(pairingURL(), { small: true }, q => out(q.split('\n').map(l => '  ' + l).join('\n')))
  out(`  ${pairingURL()}`)
  out('')
  out('  Agent   npm run register -- --write')
  out('')
}

/// Bonjour, so the iPad needs no address typed in. macOS ships dns-sd; elsewhere the app falls
/// back to the QR or a manual address.
function advertiseBonjour() {
  if (process.platform !== 'darwin' || process.env.SKETCHPAD_NO_BONJOUR) return
  const name = process.env.SKETCHPAD_NAME || `Sketchpad on ${hostname().replace(/\.local$/, '')}`
  const child = spawn('dns-sd', ['-R', name, '_sketchpad._tcp', '.', String(PORT), 'path=/'], { stdio: 'ignore' })
  child.on('error', err => log('bonjour unavailable:', err.message))
  const stop = () => { try { child.kill() } catch {} }
  process.on('exit', stop)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(0) })
}
