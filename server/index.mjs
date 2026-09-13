// Sketchpad: one process the iPad and your agent both talk to.
//
//   iPad  ──POST /turn (page as PNG)──▶  server  ──MCP /mcp──▶  agent
//   iPad  ◀───── WebSocket /ws ───────  server  ◀──────────────
//
// Wiring only. The parts live in hub (connected iPads), state (what is in flight),
// tools (the MCP surface), routes (HTTP) and pairing (Bonjour, QR).

import { homedir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createHub } from './hub.mjs'
import { createState } from './state.mjs'
import { createRoutes } from './routes.mjs'
import { advertiseBonjour, lanIP, pairingURL, printPairing } from './pairing.mjs'

// Nothing durable lives here. The iPad keeps the pages; this is only what is in flight — a page an
// agent is reading, a file it handed over, a reply the iPad has not collected yet. Deleting it
// loses nothing you drew.
const SPOOL_DIR = process.env.SKETCHPAD_SPOOL_DIR || join(cacheHome(), 'sketchpad')

/// Where this machine puts throwaway caches.
function cacheHome() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches')
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
}

const PORT = Number(process.env.SKETCHPAD_PORT ?? 8791)
const TOKEN = process.env.SKETCHPAD_TOKEN ?? ''
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

const authorize = url => !TOKEN || url.searchParams.get('token') === TOKEN
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
  if (!QUIET) printPairing({ host: HOST, port: PORT, token: TOKEN })
  advertiseBonjour({ port: PORT, log })
})
