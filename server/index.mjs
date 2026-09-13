// Sketchpad: one process the iPad and your agent both talk to.
//
//   iPad  ──POST /turn (page as PNG)──▶  server  ──MCP /mcp──▶  agent
//   iPad  ◀───── WebSocket /ws ───────  server  ◀──────────────
//
// Wiring only. The parts live in hub (connected iPads), state (turns, replies, files),
// tools (the MCP surface), routes (HTTP) and pairing (Bonjour, QR).

import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHub } from './hub.mjs'
import { createState } from './state.mjs'
import { createRoutes } from './routes.mjs'
import { advertiseBonjour, lanIP, pairingURL, printPairing } from './pairing.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INBOX_DIR = join(ROOT, 'inbox')     // pages the iPad sent, as PNGs, beside turns.json
const OUTBOX_DIR = join(ROOT, 'outbox')   // files the agent handed over, served at /files/

const PORT = Number(process.env.SKETCHPAD_PORT ?? 8791)
const TOKEN = process.env.SKETCHPAD_TOKEN ?? ''
const HOST = process.env.SKETCHPAD_HOST || lanIP()
const QUIET = process.env.SKETCHPAD_QUIET === '1'

const log = (...args) => console.error('[sketchpad]', ...args)

for (const dir of [INBOX_DIR, OUTBOX_DIR]) mkdirSync(dir, { recursive: true })

const hub = createHub({ log: QUIET ? () => {} : log })
const state = createState({
  broadcast: hub.broadcast,
  clientCount: hub.clientCount,
  inboxDir: INBOX_DIR,
  outboxDir: OUTBOX_DIR
})

// An iPad that connects mid-session should see the current state, not a blank one.
hub.onGreeting(() => ({ type: 'hello', listening: state.isListening() }))

const authorize = url => !TOKEN || url.searchParams.get('token') === TOKEN
const server = createServer(createRoutes({
  state, hub,
  inboxDir: INBOX_DIR, outboxDir: OUTBOX_DIR,
  authorize,
  pairingURL: () => pairingURL({ host: HOST, port: PORT, token: TOKEN }),
  log: QUIET ? () => {} : log
}))
hub.attachTo(server, { authorize })

// The MCP URL your agent registered carries this port, so never move it silently.
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
  if (!QUIET) printPairing({ host: HOST, port: PORT, token: TOKEN })
  advertiseBonjour({ port: PORT, log })
})
