// Sketchpad: one process the iPad and your agent both talk to.
//
//   iPad  ──POST /turn (page as PNG)──▶  server  ──MCP /mcp──▶  agent
//   iPad  ◀───── WebSocket /ws ───────  server  ◀──────────────
//
// Wiring only. The parts live in hub (connected iPads), state (what is in flight),
// tools (the MCP surface), routes (HTTP) and pairing (Bonjour, QR).

import { createServer } from 'node:http'
import { createHub } from './hub.mjs'
import { createState } from './state.mjs'
import { createRoutes } from './routes.mjs'
import { advertiseBonjour, lanIP, pairingURL, printPairing } from './pairing.mjs'
import { loadOrCreateToken, makeAuthorizer } from './auth.mjs'
import { spoolDir } from './paths.mjs'

// Nothing durable lives here. The iPad keeps the pages; this is only what is in flight — a page an
// agent is reading, a file it handed over, a reply the iPad has not collected yet. Deleting it
// loses nothing you drew.
const SPOOL_DIR = spoolDir()

const PORT = Number(process.env.SKETCHPAD_PORT ?? 8791)
// Generated on first run and kept, so there is no unprotected default. SKETCHPAD_NO_TOKEN=1 opts out.
const { token: TOKEN, source: TOKEN_SOURCE } = loadOrCreateToken()
const HOST = process.env.SKETCHPAD_HOST || lanIP()
const QUIET = process.env.SKETCHPAD_QUIET === '1'

const log = (...args) => console.error('[sketchpad]', ...args)

const hub = createHub({ log: QUIET ? () => {} : log })
const state = createState({
  broadcast: hub.broadcast,
  clientCount: hub.clientCount,
  spoolDir: SPOOL_DIR
})
state.prune()

// An iPad that connects mid-session should see the current state, not a blank one.
hub.onGreeting(() => ({ type: 'hello', listening: state.isListening() }))

// `sketchpad pair` wants the QR without a second server fighting for the port.
if (process.env.SKETCHPAD_PAIR_ONLY === '1') {
  printPairing({ host: HOST, port: PORT, token: TOKEN, tokenSource: TOKEN_SOURCE })
  process.exit(0)
}

const authorize = makeAuthorizer({ token: TOKEN, allowRemoteMCP: process.env.SKETCHPAD_MCP_REMOTE === '1' })
const server = createServer(createRoutes({
  state, hub,
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
  if (!QUIET) printPairing({ host: HOST, port: PORT, token: TOKEN, tokenSource: TOKEN_SOURCE })
  advertiseBonjour({ port: PORT, log })
})
