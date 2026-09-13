// Sketchpad: one process the iPad and your agent both talk to.
//
//   iPad  ──POST /turn (page as PNG)──▶  server  ──MCP /mcp──▶  agent
//   iPad  ◀───── WebSocket /ws ───────  server  ◀──────────────
//
// Wiring only. The parts live in hub (connected iPads), state (what is in flight),
// tools (the MCP surface), routes (HTTP) and pairing (Bonjour, QR).

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHub } from './hub.mjs'
import { createState } from './state.mjs'
import { createRoutes } from './routes.mjs'
import { advertiseBonjour, lanIP, pairingURL, printPairing } from './pairing.mjs'
import { loadOrCreateToken, makeAuthorizer } from './auth.mjs'
import { spoolDir, configDir } from './paths.mjs'
import { createDevices } from './devices.mjs'
import { loadOrCreateCert } from './tls.mjs'

// Nothing durable lives here. The iPad keeps the pages; this is only what is in flight — a page an
// agent is reading, a file it handed over, a reply the iPad has not collected yet. Deleting it
// loses nothing you drew.
const SPOOL_DIR = spoolDir()

const PORT = Number(process.env.SKETCHPAD_PORT ?? 8791)
// Generated on first run and kept, so there is no unprotected default. SKETCHPAD_NO_TOKEN=1 opts out.
const { token: TOKEN } = loadOrCreateToken()
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

// Encrypted by default. SKETCHPAD_NO_TLS=1 drops back to plain http, which is only reasonable on a
// network you control or a tunnel that already encrypts (Tailscale, say).
const TLS = process.env.SKETCHPAD_NO_TLS !== '1'
const tls = TLS ? await loadOrCreateCert({ dir: configDir(), hosts: [HOST] }) : null
const SCHEME = TLS ? 'https' : 'http'

const devices = createDevices({ dir: configDir() })
const authorize = makeAuthorizer({ token: TOKEN, devices, allowRemoteMCP: process.env.SKETCHPAD_MCP_REMOTE === '1' })
const handler = createRoutes({
  state, hub, devices,
  authorize,
  pairingURL: code => pairingURL({ host: HOST, port: PORT, token: TOKEN, code, scheme: SCHEME, fingerprint: tls?.fingerprint }),
  log: QUIET ? () => {} : log
})
const server = TLS ? createHttpsServer({ cert: tls.cert, key: tls.key }, handler) : createHttpServer(handler)
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
  // A token that was never paired for (SKETCHPAD_NO_TOKEN, or one set by hand) has no code to mint.
  if (!QUIET) printPairing({
    host: HOST, port: PORT, token: TOKEN,
    code: TOKEN ? devices.mintCode().code : null,
    scheme: SCHEME, fingerprint: tls?.fingerprint
  })
  advertiseBonjour({ port: PORT, log })
})
