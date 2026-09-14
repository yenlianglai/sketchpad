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

// What a client is told at connect time. For Claude Code this is backed up by the skill; for
// everything else it is the only guidance there is, so it has to carry the loop, the start and the
// stop — not just a list of what the tools do.
export const INSTRUCTIONS = [
  'A person is drawing on an iPad with a pencil. The iPad is how they write to you; your own conversation is where they read your answer — answer there, at whatever length the question deserves, and use the iPad for what belongs on it.',
  'Start with sketchpad_status. If no iPad is connected it carries a pairing code: read out those eight characters, tell them to type it into Settings → Pair on the iPad, and stop. Do not wait for something that is not there. If they ask for a code while one is already connected — they are adding a second iPad — call status again with pairing_code: true.',
  'When one is connected, say once that you are listening, then call sketchpad_wait_for_turn (timeout_seconds 50). "No turn" only means the time ran out — call it again, silently, without narrating each attempt. If it reports ipad_connected=false twice, the iPad has gone: say so and stop.',
  'When a page arrives, look at the image first: grey strokes are ones you have already seen, dark strokes are new this turn, and layers you handed over earlier are underneath. Work out what they want before deciding how to answer — a page can be a question, a plan to pick holes in, or a note to themselves.',
  'Answer in your conversation. Then sketchpad_show, with the same turn_id: always a sentence of text so they know the page landed; svg in that image\'s pixel coordinates when a drawn addition is the answer, not as decoration; text with place_as_layer when words belong beside the drawing; image_path (absolute) when you actually rendered something.',
  'Then wait for the next turn. Stop when they ask, or when the request takes you elsewhere.'
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
        image_path: { type: 'string', description: 'Absolute path of a rendered image (png/jpg/svg/webp/pdf) on THIS machine. Only use it when you are certain of the absolute path and that this server can read it — if you are in a container or sandbox, or only have a path relative to your own project, send image_data instead rather than guessing at a prefix.' },
        image_data: { type: 'string', description: 'The image itself, base64. Works from anywhere: no shared filesystem, no absolute path to work out. Prefer this when a tool gave you a relative path or you rendered the image somewhere isolated.' },
        kind: { type: 'string', enum: ['sketch', 'mermaid', 'drawio', 'image', 'other'], description: 'What image_path is. Shown as a label on the iPad.' },
        place_as_layer: { type: 'boolean', description: 'Suggest putting it straight onto the canvas. With image_path this places the image; on its own it places your text as a note they can move, trace and draw over. The person still decides.' },
        turn_id: { type: 'string', description: 'The turn this replies to. Required for svg coordinates to land correctly.' }
      },
      required: ['text']
    }
  },
  {
    name: 'sketchpad_status',
    description: 'Whether an iPad is connected, which page it has open, how many pages are waiting, and who else is listening — agents_waiting above 1 means another agent may take the next page instead of you. When nothing is connected it also carries a pairing code to read out. Ask for pairing_code when they want to connect another iPad, or when they ask for the code and one is already connected.',
    inputSchema: {
      type: 'object',
      properties: {
        pairing_code: { type: 'boolean', description: 'Include a code even though an iPad is already connected — for adding a second one.' }
      }
    }
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
      if (a.image_data) {
        files.push({ ...state.publishBytes(a.image_data, a.image_path || a.kind || 'image'), kind: a.kind || 'image', layer: a.place_as_layer === true })
      } else if (a.image_path) {
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

    async sketchpad_status(a = {}) {
      const connected = clientCount() > 0
      // Nothing connected is the moment a code is obviously wanted, so it comes with the answer
      // rather than needing a second tool — but it has to be askable for as well, or there is no way
      // to add a second iPad while the first one is there. The outstanding code is reused: asking
      // twice should not quietly invalidate one somebody is halfway through typing.
      const wanted = !connected || a.pairing_code === true
      const code = wanted ? (devices?.pendingCode() ?? devices?.mintCode().formatted ?? null) : null
      return text(JSON.stringify({
        ipad_connected: clientCount() > 0,
        clients: clientCount(),
        pending_turns: state.pending(),
        agent_listening: state.isListening(),
        agents_waiting: state.waiting(),
        you: agent ? { id: agent.id, name: agent.name } : null,
        other_agents: (agents?.list() ?? []).filter(x => x.id !== agent?.id).map(x => ({ name: x.name, waiting: x.waiting })),
        ...(code ? { pairing_code: code, pairing: `Read out "${code}" — they type it into Settings → Pair on the iPad. Good for ten minutes.` } : {}),
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
