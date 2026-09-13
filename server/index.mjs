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
import { addresses, advertiseBonjour } from './addresses.mjs'
import { pairing, printPairing } from './pairing.mjs'
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
const ADDRESSES = addresses()
const HOST = process.env.SKETCHPAD_HOST || ADDRESSES.primary
// The others this machine answers on, so switching between wifi and ethernet needs no re-pair.
const ALT = ADDRESSES.all.filter(a => a !== HOST)
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
// network you control or behind something that already encrypts.
const TLS = process.env.SKETCHPAD_NO_TLS !== '1'
// Every address the certificate has to be valid for, or dialling one of the others would fail the
// name check even with the right fingerprint.
const tls = TLS ? await loadOrCreateCert({ dir: configDir(), hosts: [HOST, ...ALT] }) : null
const SCHEME = TLS ? 'https' : 'http'

// A pairing proof is bound to this server's certificate, so devices has to know it.
const devices = createDevices({ dir: configDir(), fingerprint: () => tls?.fingerprint ?? '' })
const authorize = makeAuthorizer({ token: TOKEN, devices, allowRemoteMCP: process.env.SKETCHPAD_MCP_REMOTE === '1' })
const handler = createRoutes({
  state, hub, devices,
  authorize,
  pairing: (code, expiresAt) => pairing({ host: HOST, port: PORT, code, expiresAt, alt: ALT }),
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
    code: TOKEN ? devices.mintCode().formatted : null,
    alt: ALT
  })
  advertiseBonjour({ port: PORT, log })
})
