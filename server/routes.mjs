// The HTTP surface. Two audiences on one port: the iPad app, and any agent speaking MCP over
// Streamable HTTP at /mcp.

import { readFileSync, existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildMcpServer } from './tools.mjs'

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json'
}

const readBody = req => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}
const json = (res, value) => send(res, 200, JSON.stringify(value), 'application/json')

const stripDataURL = s => s.replace(/^data:image\/png;base64,/, '')

export function createRoutes({ state, hub, authorize, pairingURL, log = () => {} }) {
  /// Stateless Streamable HTTP: a fresh transport and server per request, all sharing one state.
  async function handleMCP(req, res) {
    let body
    if (req.method === 'POST') {
      try { body = JSON.parse((await readBody(req)).toString('utf8')) } catch { return send(res, 400, 'invalid json') }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const server = buildMcpServer({ state, broadcast: hub.broadcast, clientCount: hub.clientCount, log })
    res.on('close', () => { transport.close(); server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /// The iPad sends a page: strokes rendered to PNG, plus whatever it wrote as a note.
  async function receiveTurn(req, res) {
    const body = JSON.parse((await readBody(req)).toString('utf8'))
    const turnId = randomUUID().slice(0, 8)
    let pngPath = null
    let pngBase64 = null
    if (body.png) {
      pngBase64 = stripDataURL(body.png)
      pngPath = state.spoolPage(turnId, pngBase64)   // a working copy for the agent, not a record
    }
    state.pushTurn({
      turnId, text: body.text, pngPath, pngBase64, strokes: body.strokes,
      boardId: body.boardId, boardTitle: body.boardTitle, ts: Date.now()
    })
    log(`page ${turnId}  "${(body.text || '').slice(0, 40)}"  ${body.strokes ?? '?'} new strokes`)
    hub.broadcast({ type: 'turn', turnId, ts: Date.now() })
    return json(res, { turnId, pngPath, delivered: true })
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    if (!authorize(url)) return send(res, 401, 'bad token')
    try {
      if (url.pathname === '/mcp') return handleMCP(req, res)
      if (req.method === 'POST' && url.pathname === '/turn') return receiveTurn(req, res)

      // The iPad answering something we asked it — a canvas snapshot, or a slice of its history.
      if (req.method === 'POST' && (url.pathname === '/answer' || url.pathname === '/snapshot')) {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        if (body.png) body.png = stripDataURL(body.png)
        if (body.turn?.png) body.turn.png = stripDataURL(body.turn.png)
        state.answer(body.id, body)
        return send(res, 200, 'ok')
      }

      // Replies the iPad missed while it was disconnected.
      if (url.pathname === '/replies') {
        return json(res, state.repliesSince(Number(url.searchParams.get('since') || 0)))
      }

      if (url.pathname === '/pair') return json(res, pairingURL())

      if (url.pathname === '/health') {
        return json(res, {
          ok: true, clients: hub.clientCount(),
          pending_turns: state.pending(), agent_listening: state.isListening()
        })
      }

      // Files the agent handed over, fetched by the iPad.
      if (url.pathname.startsWith('/files/')) {
        const name = basename(url.pathname)
        const path = state.spooledFile(name)
        if (!existsSync(path)) return send(res, 404, 'not found')
        return send(res, 200, readFileSync(path), MIME[extname(name).toLowerCase()] ?? 'application/octet-stream')
      }

      return send(res, 200, `Sketchpad is running.\n\nMCP endpoint: /mcp\nPair an iPad:  ${pairingURL().url}\n`)
    } catch (err) {
      log('request failed:', err.message)
      return send(res, 500, err.message)
    }
  }
}
