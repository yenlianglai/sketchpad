// Sketchpad as a plain MCP server: the iPad is an input device, the agent owns the conversation.
//
// Tools (provider-agnostic; any MCP client can call them):
//   sketchpad_wait_for_turn  block until the person finishes a turn → note + PNG image block
//   sketchpad_get_canvas     grab what is on the canvas right now
//   sketchpad_show           message back; optionally draw (svg → editable strokes) or hand over a
//                            rendered image (mermaid / draw.io / generated PNG or SVG) as a canvas layer
//   sketchpad_list_turns     every turn of the current (or a given) page, newest first
//   sketchpad_get_turn       one earlier turn's note + image
//   sketchpad_set_title      name the current page (the person can rename later)
//   sketchpad_status         is an iPad connected, how many turns are queued
//
// One instance of this state lives in the server process; buildServer() creates a fresh
// MCP Server bound to that shared state for every transport (stdio, or one per HTTP request).

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export function createSketchpad({ log, broadcast, clientCount, inboxDir, outboxDir }) {
  const queue = []            // turns not yet taken by an agent
  const waiters = []          // resolvers of pending wait_for_turn calls
  const snapshots = new Map() // id → resolve(pngBase64|null)
  let lastTurn = null
  let currentBoard = null     // { id, title } of the page the iPad has open

  // ---- turn manifest: inbox/turns.json (one record per turn, PNG kept beside it) ----
  const manifestPath = join(inboxDir, 'turns.json')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : []
  const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 1))

  function pushTurn(turn) {
    lastTurn = turn
    if (turn.boardId) currentBoard = { id: turn.boardId, title: turn.boardTitle || currentBoard?.title || '' }
    manifest.push({ turnId: turn.turnId, boardId: turn.boardId ?? null, boardTitle: turn.boardTitle ?? null, ts: turn.ts, text: turn.text ?? '', strokes: turn.strokes ?? null, pngPath: turn.pngPath ?? null, replies: [] })
    saveManifest()
    queue.push(turn)
    const w = waiters.shift()
    if (w) w()
  }

  function recordReply(turnId, reply) {
    const rec = manifest.find(t => t.turnId === turnId) ?? manifest[manifest.length - 1]
    if (rec) { rec.replies.push(reply); saveManifest() }
  }

  /// Replies newer than `sinceMs`, oldest first — so an iPad that was asleep or offline can pick up
  /// what it missed instead of losing it.
  function recentReplies(sinceMs = 0, limit = 30) {
    const out = []
    for (const t of manifest) for (const r of t.replies) if ((r.ts ?? 0) > sinceMs) out.push({ ...r, turnId: r.turnId ?? t.turnId })
    out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    return out.slice(-limit)
  }

  // "Is an agent actually in the loop?" — true while someone is blocked in wait_for_turn, and for a
  // grace period after, so the gap between two polls doesn't flicker the iPad's status light.
  const LISTEN_GRACE_MS = 90_000
  let lastWaitAt = 0
  let listening = false
  let graceTimer = null
  function updateListening() {
    clearTimeout(graceTimer)
    const active = waiters.length > 0 || Date.now() - lastWaitAt < LISTEN_GRACE_MS
    if (active !== listening) { listening = active; broadcast({ type: 'agents', listening }) }
    if (active && waiters.length === 0) graceTimer = setTimeout(updateListening, Math.max(1000, LISTEN_GRACE_MS - (Date.now() - lastWaitAt) + 500))
  }

  function takeTurn(timeoutMs) {
    lastWaitAt = Date.now()
    if (queue.length) { updateListening(); return Promise.resolve(queue.shift()) }
    return new Promise(resolve => {
      const done = value => { const i = waiters.indexOf(wake); if (i >= 0) waiters.splice(i, 1); lastWaitAt = Date.now(); updateListening(); resolve(value) }
      const timer = setTimeout(() => done(null), timeoutMs)
      const wake = () => { clearTimeout(timer); done(queue.shift() ?? null) }
      waiters.push(wake)
      updateListening()
    })
  }

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

  const pngSize = b64 => { try { const b = Buffer.from(b64.slice(0, 64), 'base64'); return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` } catch { return '?' } }
  const readPngBase64 = p => { try { return readFileSync(p).toString('base64') } catch { return null } }

  const turnText = (t, pending) => [
    `turn_id=${t.turnId}` + (t.boardTitle ? ` page="${t.boardTitle}"` : ''),
    t.text?.trim() ? `note: ${t.text.trim()}` : 'note: (none — respond to the drawing)',
    `new_strokes=${t.strokes ?? '?'}` + (t.pngBase64 ? ` image_px=${pngSize(t.pngBase64)} (grey strokes = already seen, dark = new)` : ''),
    t.pngPath ? `sketch_file=${t.pngPath}` : 'sketch: (canvas empty)',
    `pending_turns=${pending}`,
    'Draw back: sketchpad_show with svg in THIS image\'s pixel coordinates (viewBox="0 0 W H"), stroke-only, same turn_id. Hand over a rendered diagram/image: sketchpad_show with image_path (it becomes a movable layer under their strokes).'
  ].join('\n')

  // Copy a file the agent produced into outbox so the iPad can fetch it over /files/.
  function publishFile(p) {
    const st = statSync(p)
    if (st.size > 50 * 1024 * 1024) throw new Error(`file too large: ${p}`)
    const ext = extname(p).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.svg', '.webp', '.pdf'].includes(ext)) throw new Error(`unsupported file type ${ext}; use png/jpg/svg/webp/pdf`)
    mkdirSync(outboxDir, { recursive: true })
    const name = `${Date.now()}-${basename(p)}`
    copyFileSync(p, join(outboxDir, name))
    return { url: `/files/${name}`, name: basename(p) }
  }

  const TOOLS = [
    {
      name: 'sketchpad_wait_for_turn',
      description: 'Wait until the person on the iPad finishes a turn (they stop drawing for a moment, or press Send). Returns their handwritten note (if any) plus a PNG of the page as an image block. Returns immediately if a turn is already queued; returns "no turn" after timeout_seconds — call again to keep listening.',
      inputSchema: { type: 'object', properties: {
        timeout_seconds: { type: 'number', description: 'How long to wait. Default 50. Keep under your MCP tool timeout.' },
        include_image: { type: 'boolean', description: 'Attach the drawing as an image block. Default true.' }
      } }
    },
    {
      name: 'sketchpad_get_canvas',
      description: 'Snapshot the iPad canvas right now as a PNG image block, without waiting for a turn.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'sketchpad_show',
      description: 'Reply to the person. `text` appears in their side panel. Two ways to put something on their canvas: (1) `svg` — stroke-only shapes in the pixel coordinates of the turn_id image (viewBox="0 0 W H", W×H = image_px); converted into editable pen strokes placed exactly over their drawing. Use for small additions: a box, an arrow, a corrected line. (2) `image_path` — a rendered mermaid / draw.io / generated image (png, jpg, svg, webp) as an absolute path on this machine; the iPad shows it in the panel and, with `place_as_layer`, drops it onto the canvas as a movable, resizable layer beneath their strokes. Always pass `kind` for image_path so the panel labels it.',
      inputSchema: { type: 'object', properties: {
        text: { type: 'string', description: 'One or two sentences.' },
        svg: { type: 'string', description: 'Stroke-only SVG in the pixel space of the turn_id image. Default stroke colour is the agent colour if omitted.' },
        image_path: { type: 'string', description: 'Absolute path of a rendered image (png/jpg/svg/webp/pdf) to hand over.' },
        kind: { type: 'string', enum: ['sketch', 'mermaid', 'drawio', 'image', 'other'], description: 'What image_path is. Shown as a label on the iPad.' },
        place_as_layer: { type: 'boolean', description: 'Put image_path onto the canvas immediately as a layer (default false: panel only, the person taps to place).' },
        turn_id: { type: 'string', description: 'The turn this replies to. Required for svg coordinates to land correctly.' }
      }, required: ['text'] }
    },
    {
      name: 'sketchpad_list_turns',
      description: 'List turns (newest first): turn_id, time, page, note, new_strokes, and what you replied. Defaults to the page the iPad currently has open.',
      inputSchema: { type: 'object', properties: {
        board_id: { type: 'string', description: 'Page id. Omit for the current page; pass "all" for every page.' },
        limit: { type: 'number', description: 'Default 20.' }
      } }
    },
    {
      name: 'sketchpad_get_turn',
      description: 'Fetch one earlier turn: its note and the PNG the person sent at that moment (image block). Use to compare versions or answer "what did I change".',
      inputSchema: { type: 'object', properties: { turn_id: { type: 'string' }, include_image: { type: 'boolean', description: 'Default true.' } }, required: ['turn_id'] }
    },
    {
      name: 'sketchpad_set_title',
      description: 'Give the current page a short title based on what is being drawn (2–5 words). The person can rename it later. Call once you understand what the page is about, not on every turn.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, board_id: { type: 'string', description: 'Omit for the current page.' } }, required: ['title'] }
    },
    {
      name: 'sketchpad_status',
      description: 'Whether an iPad is connected, the current page, and how many turns are waiting.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]

  function buildServer() {
    const server = new Server(
      { name: 'sketchpad', version: '0.3.0' },
      {
        capabilities: { tools: {} },
        instructions: 'A person is drawing on an iPad with a pencil. Call sketchpad_wait_for_turn to receive each turn: a PNG of their page (grey = strokes you already saw, dark = new since last turn) plus an optional handwritten note. Look at the image first. Answer with sketchpad_show: a short text; an svg in that image\'s pixel coordinates when a small drawn addition helps (it becomes editable strokes on their canvas); or image_path when you have rendered a diagram or generated an image (it becomes a layer they can move and draw over). Use sketchpad_list_turns / sketchpad_get_turn to look back at earlier versions. Name the page with sketchpad_set_title once you know what it is. Then wait for the next turn. Stop when the person asks or the request takes you elsewhere.'
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
            if (a.svg) files.push({ url: 'data:image/svg+xml;base64,' + Buffer.from(String(a.svg)).toString('base64'), name: 'drawing.svg', kind: 'sketch' })
            if (a.image_path) files.push({ ...publishFile(String(a.image_path)), kind: a.kind || 'image', layer: a.place_as_layer === true })
            const reply = { type: 'reply', id: randomUUID(), text: String(a.text ?? ''), files, turnId: a.turn_id ?? lastTurn?.turnId, ts: Date.now() }
            broadcast(reply)
            recordReply(reply.turnId, { id: reply.id, turnId: reply.turnId, text: reply.text, files, ts: reply.ts })
            return { content: [{ type: 'text', text: clientCount() ? 'shown' : 'shown (no iPad connected right now)' }] }
          }
          case 'sketchpad_list_turns': {
            const board = a.board_id ?? currentBoard?.id
            const rows = manifest.filter(t => a.board_id === 'all' || !board || t.boardId === board).slice(-(Number(a.limit) || 20)).reverse()
            const lines = rows.map(t => `${t.turnId}  ${new Date(t.ts).toISOString().slice(11, 19)}  page="${t.boardTitle ?? ''}"  strokes=${t.strokes ?? '?'}  note=${JSON.stringify(t.text || '')}  replies=${t.replies.length}${t.replies.length ? ' (' + t.replies.map(r => r.files.map(f => f.kind).join('+') || 'text').join(', ') + ')' : ''}`)
            return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'no turns yet' }] }
          }
          case 'sketchpad_get_turn': {
            const t = manifest.find(x => x.turnId === a.turn_id)
            if (!t) return { content: [{ type: 'text', text: `unknown turn_id ${a.turn_id}` }], isError: true }
            const content = [{ type: 'text', text: `turn_id=${t.turnId} page="${t.boardTitle ?? ''}" time=${new Date(t.ts).toISOString()}\nnote: ${t.text || '(none)'}\nreplies: ${JSON.stringify(t.replies)}` }]
            const b64 = a.include_image !== false && t.pngPath ? readPngBase64(t.pngPath) : null
            if (b64) content.push({ type: 'image', data: b64, mimeType: 'image/png' })
            return { content }
          }
          case 'sketchpad_set_title': {
            const boardId = a.board_id ?? currentBoard?.id
            if (currentBoard && (!a.board_id || a.board_id === currentBoard.id)) currentBoard.title = String(a.title)
            broadcast({ type: 'title', boardId, title: String(a.title) })
            return { content: [{ type: 'text', text: `titled "${a.title}"` }] }
          }
          case 'sketchpad_status':
            return { content: [{ type: 'text', text: JSON.stringify({ ipad_connected: clientCount() > 0, clients: clientCount(), pending_turns: queue.length, current_page: currentBoard, last_turn_id: lastTurn?.turnId ?? null, turns_recorded: manifest.length }) }] }
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

  return { pushTurn, resolveSnapshot, buildServer, recentReplies, pending: () => queue.length, isListening: () => listening }
}
