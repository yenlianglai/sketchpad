// The MCP surface: eight tools over the shared state. Provider-agnostic — any MCP client can call
// these, over stdio or Streamable HTTP.
//
// buildMcpServer() makes a fresh Server bound to the same state for every transport, because the
// HTTP transport is stateless and creates one per request.

import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { pngSize } from './state.mjs'
import { VERSION } from './version.mjs'

export { VERSION } from './version.mjs'

export const INSTRUCTIONS = [
  'A person is drawing on an iPad with a pencil. The iPad is how they write to you; your own conversation is where they read your answer.',
  'Call sketchpad_wait_for_turn to receive each turn: a PNG of their page (grey = strokes you already saw, dark = new since last turn) plus an optional handwritten note. Look at the image first.',
  'Answer in your own conversation, at whatever length the question deserves. Then use sketchpad_show for what belongs on the iPad: a sentence of text so they know the page landed; an svg in that image\'s pixel coordinates when a drawn addition is the answer (it becomes editable strokes on their canvas); or image_path when you have rendered a diagram or generated an image (it becomes a layer they can move and draw over).',
  'Use sketchpad_list_turns / sketchpad_get_turn to look back at earlier versions. Name the page with sketchpad_set_title once you know what it is.',
  'Then wait for the next turn. Stop when the person asks or the request takes you elsewhere.'
].join(' ')

export const TOOLS = [
  {
    name: 'sketchpad_wait_for_turn',
    description: 'Wait until the person on the iPad sends a page (they press Send). Returns their handwritten note, if any, plus a PNG of the page as an image block. Returns immediately if a page is already queued; returns "no turn" after timeout_seconds — call again to keep listening.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: 'How long to wait. Default 50. Keep it under your MCP tool timeout.' },
        include_image: { type: 'boolean', description: 'Attach the page as an image block. Default true.' }
      }
    }
  },
  {
    name: 'sketchpad_get_canvas',
    description: 'Snapshot the iPad canvas right now as a PNG image block, without waiting for a turn.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'sketchpad_show',
    description: 'Put something on the iPad. This is not where your answer goes — answer in your own conversation, which is where they are reading — this is for what belongs on the canvas, plus a sentence so they know the page landed. `text` appears in their panel. Two ways to put something on their canvas: (1) `svg` — stroke-only shapes in the pixel coordinates of the turn_id image (viewBox="0 0 W H", W×H = image_px); it becomes editable pen strokes placed over their drawing, so use it for small additions: a box, an arrow, a corrected line. (2) `image_path` — a rendered mermaid / draw.io / generated image as an absolute path on this machine; it becomes a movable layer beneath their strokes. Pass `kind` with image_path so the panel labels it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One or two sentences.' },
        svg: { type: 'string', description: 'Stroke-only SVG in the pixel space of the turn_id image.' },
        image_path: { type: 'string', description: 'Absolute path of a rendered image (png/jpg/svg/webp/pdf). Must be absolute — this server has its own working directory, not yours.' },
        kind: { type: 'string', enum: ['sketch', 'mermaid', 'drawio', 'image', 'other'], description: 'What image_path is. Shown as a label on the iPad.' },
        place_as_layer: { type: 'boolean', description: 'Suggest putting it straight onto the canvas. With image_path this places the image; on its own it places your text as a note they can move, trace and draw over. The person still decides.' },
        turn_id: { type: 'string', description: 'The turn this replies to. Required for svg coordinates to land correctly.' }
      },
      required: ['text']
    }
  },
  {
    name: 'sketchpad_list_turns',
    description: 'List pages sent (newest first): turn_id, time, page, note, new_strokes, and what you replied. Defaults to the page the iPad currently has open. The history lives on the iPad, so this needs it connected.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string', description: 'Page id. Omit for the current page; pass "all" for every page.' },
        limit: { type: 'number', description: 'Default 20.' }
      }
    }
  },
  {
    name: 'sketchpad_get_turn',
    description: 'Fetch one earlier page: its note and the PNG as it was at that moment. Use it to compare versions or answer "what did I change". The history lives on the iPad, so this needs it connected.',
    inputSchema: {
      type: 'object',
      properties: { turn_id: { type: 'string' }, include_image: { type: 'boolean', description: 'Default true.' } },
      required: ['turn_id']
    }
  },
  {
    name: 'sketchpad_set_title',
    description: 'Give the current page a short title based on what is drawn on it (2–5 words). Call it once you understand the page, not on every turn. The person can rename it later.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, board_id: { type: 'string', description: 'Omit for the current page.' } },
      required: ['title']
    }
  },
  {
    name: 'sketchpad_pairing_code',
    description: 'Get a pairing code to read out to the person so they can connect an iPad. Eight characters they type into the app; good for ten minutes and for one device. Use it when they ask how to connect, or when no iPad is connected and they want one. Each call retires the previous code.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'sketchpad_status',
    description: 'Whether an iPad is connected, which page it has open, how many pages are waiting, and how many agents are listening. agents_waiting above 1 means another agent is competing for the next page and may take it instead of you.',
    inputSchema: { type: 'object', properties: {} }
  }
]

const text = s => ({ content: [{ type: 'text', text: s }] })
const fail = s => ({ content: [{ type: 'text', text: s }], isError: true })
const image = data => ({ type: 'image', data, mimeType: 'image/png' })

/// The iPad keeps the pages; without it there is no history to read and no page to title.
const OFFLINE = 'no iPad connected — it holds the pages, so this needs it awake and on the same network'

/// What the agent reads when a page arrives: enough to answer, and how to answer in kind.
function describeTurn(turn, pending) {
  return [
    `turn_id=${turn.turnId}` + (turn.boardTitle ? ` page="${turn.boardTitle}"` : ''),
    turn.text?.trim() ? `note: ${turn.text.trim()}` : 'note: (none — respond to the drawing)',
    `new_strokes=${turn.strokes ?? '?'}` + (turn.pngBase64 ? ` image_px=${pngSize(turn.pngBase64)} (grey strokes = already seen, dark = new)` : ''),
    turn.pngPath ? `sketch_file=${turn.pngPath}` : 'sketch: (canvas empty)',
    `pending_turns=${pending}`,
    'Draw back: sketchpad_show with svg in THIS image\'s pixel coordinates (viewBox="0 0 W H"), stroke-only, same turn_id. Hand over a rendered diagram or image: sketchpad_show with image_path.'
  ].join('\n')
}

const summariseTurn = t =>
  `${t.turnId}  ${new Date(t.ts).toISOString().slice(11, 19)}  page="${t.boardTitle ?? ''}"  strokes=${t.strokes ?? '?'}  ` +
  `note=${JSON.stringify(t.text || '')}  replies=${t.replies?.length ?? 0}` +
  (t.replies?.length ? ' (' + t.replies.map(r => r.kind || 'text').join(', ') + ')' : '')

export function buildMcpServer({ state, broadcast, clientCount, devices, agents = null, agent = null, log = () => {} }) {
  const server = new Server({ name: 'sketchpad', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  const handlers = {
    async sketchpad_wait_for_turn(a) {
      const seconds = Math.min(Math.max(Number(a.timeout_seconds ?? 50), 1), 600)
      agents?.setWaiting(agent?.id, true)
      let turn
      try {
        turn = await state.takeTurn(seconds * 1000, agent?.id ?? null)
      } finally {
        agents?.setWaiting(agent?.id, false)
      }
      if (!turn) return text(`no turn within ${seconds}s (ipad_connected=${clientCount() > 0}). Call again to keep listening.`)
      broadcast({ type: 'taken', turnId: turn.turnId })
      const content = [{ type: 'text', text: describeTurn(turn, state.pending()) }]
      if (a.include_image !== false && turn.pngBase64) content.push(image(turn.pngBase64))
      return { content }
    },

    async sketchpad_get_canvas() {
      const answer = await state.requestSnapshot()
      if (!answer) return fail(clientCount() ? 'canvas snapshot timed out' : OFFLINE)
      if (!answer.png) return text('the canvas is empty — nothing drawn on the page yet')
      return { content: [{ type: 'text', text: 'current canvas' }, image(answer.png)] }
    },

    async sketchpad_show(a) {
      const files = []
      if (a.svg) {
        files.push({ url: 'data:image/svg+xml;base64,' + Buffer.from(String(a.svg)).toString('base64'), name: 'drawing.svg', kind: 'sketch' })
      }
      if (a.image_path) {
        files.push({ ...state.publishFile(String(a.image_path)), kind: a.kind || 'image', layer: a.place_as_layer === true })
      } else if (a.place_as_layer === true && String(a.text ?? '').trim()) {
        // Text for the canvas rather than the panel. The iPad lays it out, because it knows the
        // page it is going onto — and it keeps the words, so they stay selectable and legible at
        // any zoom rather than being baked into a picture here.
        files.push({ kind: 'note', name: 'note', note: String(a.text), layer: true })
      }
      const reply = {
        type: 'reply', id: randomUUID(), text: String(a.text ?? ''), files,
        turnId: a.turn_id ?? state.lastTurn?.turnId, ts: Date.now()
      }
      broadcast(reply)
      state.recordReply({ id: reply.id, turnId: reply.turnId, text: reply.text, files, ts: reply.ts })
      return text(clientCount() ? 'shown' : 'shown (no iPad connected right now)')
    },

    async sketchpad_list_turns(a) {
      const rows = await state.listTurns({ boardId: a.board_id, limit: Number(a.limit) || 20 })
      if (!rows) return fail(OFFLINE)
      return text(rows.length ? rows.map(summariseTurn).join('\n') : 'no turns yet')
    },

    async sketchpad_get_turn(a) {
      const turn = await state.getTurn(a.turn_id, a.include_image !== false)
      if (!turn) return fail(clientCount() ? `unknown turn_id ${a.turn_id}` : OFFLINE)
      const content = [{
        type: 'text',
        text: `turn_id=${turn.turnId} page="${turn.boardTitle ?? ''}" time=${new Date(turn.ts).toISOString()}\n` +
              `note: ${turn.text || '(none)'}\nreplies: ${JSON.stringify(turn.replies ?? [])}`
      }]
      if (turn.png) content.push(image(turn.png))
      return { content }
    },

    async sketchpad_set_title(a) {
      if (!clientCount()) return fail(OFFLINE)
      broadcast({ type: 'title', title: String(a.title), boardId: a.board_id ?? state.currentBoard?.id })
      return text(`titled "${a.title}"`)
    },

    async sketchpad_pairing_code() {
      const { formatted } = devices.mintCode()
      return text([
        `pairing code: ${formatted}`,
        'Read it out to them. In Sketchpad on the iPad: Settings → Pair, type the code.',
        'Good for ten minutes, and for one iPad. Asking again replaces it.'
      ].join('\n'))
    },

    async sketchpad_status() {
      return text(JSON.stringify({
        ipad_connected: clientCount() > 0,
        clients: clientCount(),
        pending_turns: state.pending(),
        agent_listening: state.isListening(),
        agents_waiting: state.waiting(),
        you: agent ? { id: agent.id, name: agent.name } : null,
        other_agents: (agents?.list() ?? []).filter(x => x.id !== agent?.id).map(x => ({ name: x.name, waiting: x.waiting })),
        current_page: state.currentBoard,
        last_turn_id: state.lastTurn?.turnId ?? null
      }))
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const handler = handlers[req.params.name]
    if (!handler) return fail(`unknown tool: ${req.params.name}`)
    try {
      return await handler(req.params.arguments ?? {})
    } catch (err) {
      log('tool failed:', req.params.name, err.message)
      return fail(`${req.params.name} failed: ${err.message}`)
    }
  })

  return server
}
