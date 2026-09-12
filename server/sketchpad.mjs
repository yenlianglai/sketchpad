// Sketchpad as a plain MCP server: the iPad is an input device, the agent owns the conversation.
//
// Tools (provider-agnostic; any MCP client can call them):
//   sketchpad_wait_for_turn  block until the person finishes a turn (speech + drawing) → text + PNG image block
//   sketchpad_get_canvas     grab what is on the canvas right now, without waiting for speech
//   sketchpad_show           put a short message and/or an SVG on the iPad screen
//   sketchpad_status         is an iPad connected, how many turns are queued
//
// One instance of this state lives in the server process; buildServer() creates a fresh
// MCP Server bound to that shared state for every transport (stdio, or one per HTTP request).

import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export function createSketchpad({ log, broadcast, clientCount }) {
  const queue = []          // turns not yet taken by an agent
  const waiters = []        // resolvers of pending wait_for_turn calls
  const snapshots = new Map() // id → resolve(pngBase64|null)
  let lastTurn = null

  function pushTurn(turn) {
    lastTurn = turn
    queue.push(turn)
    const w = waiters.shift()
    if (w) w()
  }

  function takeTurn(timeoutMs) {
    if (queue.length) return Promise.resolve(queue.shift())
    return new Promise(resolve => {
      const timer = setTimeout(() => { const i = waiters.indexOf(wake); if (i >= 0) waiters.splice(i, 1); resolve(null) }, timeoutMs)
      const wake = () => { clearTimeout(timer); resolve(queue.shift() ?? null) }
      waiters.push(wake)
    })
  }

  // Ask the connected iPad(s) for a fresh PNG of the canvas.
  function requestSnapshot(timeoutMs = 4000) {
    if (clientCount() === 0) return Promise.resolve(null)
    const id = randomUUID().slice(0, 8)
    return new Promise(resolve => {
      const timer = setTimeout(() => { snapshots.delete(id); resolve(null) }, timeoutMs)
      snapshots.set(id, png => { clearTimeout(timer); snapshots.delete(id); resolve(png) })
      broadcast({ type: 'snapshot_request', id })
    })
  }
  function resolveSnapshot(id, pngBase64) { snapshots.get(id)?.(pngBase64 || null) }

  // PNG IHDR: width/height are big-endian uint32 at bytes 16..24.
  const pngSize = b64 => { try { const b = Buffer.from(b64.slice(0, 64), 'base64'); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` } catch { return '?' } }
  const turnText = (t, pending) => [
    `turn_id=${t.turnId}`,
    t.text?.trim() ? `note: ${t.text.trim()}` : 'note: (none — respond to the drawing)',
    `new_strokes=${t.strokes ?? '?'}` + (t.pngBase64 ? ` image_px=${pngSize(t.pngBase64)} (grey strokes = already seen, dark = new)` : ''),
    t.pngPath ? `sketch_file=${t.pngPath}` : 'sketch: (canvas empty)',
    `pending_turns=${pending}`,
    'To draw back: sketchpad_show with svg in THIS image\'s pixel coordinates (viewBox="0 0 W H"), stroke-only shapes, and this turn_id.'
  ].join('\n')

  const TOOLS = [
    {
      name: 'sketchpad_wait_for_turn',
      description: 'Wait until the person on the iPad finishes a turn (they stop talking, or press send). Returns what they said plus a PNG of their drawing as an image block. Returns immediately if a turn is already queued; returns "no turn" after timeout_seconds — just call again to keep listening.',
      inputSchema: { type: 'object', properties: {
        timeout_seconds: { type: 'number', description: 'How long to wait. Default 50. Keep under your MCP tool timeout.' },
        include_image: { type: 'boolean', description: 'Attach the drawing as an image block. Default true.' }
      } }
    },
    {
      name: 'sketchpad_get_canvas',
      description: 'Snapshot the iPad canvas right now as a PNG image block, without waiting for speech.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'sketchpad_show',
      description: 'Show a short message on the iPad and optionally DRAW on the person\'s canvas. The svg is converted into editable pen strokes placed exactly over the image of turn_id, so use that image\'s pixel coordinates (viewBox="0 0 W H" where WxH is image_px). Use stroke-only shapes: rect, circle, ellipse, line, polyline, polygon, path (M L H V C Q Z). Fills and <text> are dropped. Keep it minimal: a box, an arrow, a corrected line. The person can erase, move, or draw over what you add and send it back.',
      inputSchema: { type: 'object', properties: {
        text: { type: 'string', description: 'Short message shown in the side panel (one or two sentences).' },
        svg: { type: 'string', description: 'Optional stroke-only SVG in the pixel space of the turn_id image. Default stroke colour is orange if omitted; stroke-width in image pixels.' },
        turn_id: { type: 'string', description: 'The turn whose image your svg coordinates refer to. Strongly recommended when passing svg.' }
      }, required: ['text'] }
    },
    {
      name: 'sketchpad_status',
      description: 'Whether an iPad is connected and how many turns are waiting.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]

  function buildServer() {
    const server = new Server(
      { name: 'sketchpad', version: '0.2.0' },
      {
        capabilities: { tools: {} },
        instructions: 'A person is drawing on an iPad with a pencil. Call sketchpad_wait_for_turn to receive each turn: a PNG of their drawing (grey = strokes you already saw, dark = new since last turn) plus an optional handwritten note. Look at the image first. Answer with sketchpad_show: a short text, and when it helps, an svg drawn in that image\'s pixel coordinates — it becomes editable strokes on their canvas, so you two can iterate on the same drawing. Then wait for the next turn. Stop when the person asks or the request takes you elsewhere.'
      }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async req => {
      const a = req.params.arguments ?? {}
      try {
        switch (req.params.name) {
          case 'sketchpad_wait_for_turn': {
            const timeoutMs = Math.min(Math.max(Number(a.timeout_seconds ?? 50), 1), 600) * 1000
            const t = await takeTurn(timeoutMs)
            if (!t) return { content: [{ type: 'text', text: `no turn within ${timeoutMs / 1000}s (ipad_connected=${clientCount() > 0}). Call again to keep listening.` }] }
            broadcast({ type: 'taken', turnId: t.turnId })
            const content = [{ type: 'text', text: turnText(t, queue.length) }]
            if (a.include_image !== false && t.pngBase64) content.push({ type: 'image', data: t.pngBase64, mimeType: 'image/png' })
            return { content }
          }
          case 'sketchpad_get_canvas': {
            const png = await requestSnapshot()
            if (!png) return { content: [{ type: 'text', text: clientCount() ? 'canvas snapshot timed out' : 'no iPad connected' }], isError: true }
            return { content: [{ type: 'text', text: 'current canvas' }, { type: 'image', data: png, mimeType: 'image/png' }] }
          }
          case 'sketchpad_show': {
            const files = []
            if (a.svg) files.push({ url: 'data:image/svg+xml;base64,' + Buffer.from(String(a.svg)).toString('base64'), name: 'drawing.svg' })
            broadcast({ type: 'reply', id: randomUUID(), text: String(a.text ?? ''), files, turnId: a.turn_id, ts: Date.now() })
            return { content: [{ type: 'text', text: clientCount() ? 'shown' : 'shown (no iPad connected right now)' }] }
          }
          case 'sketchpad_status':
            return { content: [{ type: 'text', text: JSON.stringify({ ipad_connected: clientCount() > 0, clients: clientCount(), pending_turns: queue.length, last_turn_id: lastTurn?.turnId ?? null }) }] }
          default:
            return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
        }
      } catch (err) {
        log('tool error', req.params.name, err.message)
        return { content: [{ type: 'text', text: `${req.params.name} failed: ${err.message}` }], isError: true }
      }
    })
    return server
  }

  return { pushTurn, resolveSnapshot, buildServer, pending: () => queue.length }
}
