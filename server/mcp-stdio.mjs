#!/usr/bin/env node
// Sketchpad as a stdio MCP server, for any client that spawns local processes
// (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, ADK's StdioServerParameters…).
//
// It is a thin proxy, not a second server: the sketchpad state and the iPad's WebSocket live in one
// shared process. On start this wrapper looks for that process and starts it if nobody has, then
// forwards tools/list and tools/call to its /mcp endpoint. Several clients can run wrappers at once;
// they all talk to the same sketchpad, so they all see the same iPad.
//
// Nothing but MCP protocol may go to stdout — logs go to stderr.

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BASE = (process.env.SKETCHPAD_URL || 'http://127.0.0.1:8791').replace(/\/+$/, '')
const AUTOSTART = process.env.SKETCHPAD_NO_AUTOSTART !== '1'
const log = (...a) => console.error('[sketchpad-mcp]', ...a)

const health = async (ms = 1200) => {
  try {
    const c = AbortSignal.timeout(ms)
    const r = await fetch(`${BASE}/health`, { signal: c })
    return r.ok ? await r.json() : null
  } catch { return null }
}

async function ensureServer() {
  const alive = await health()
  if (alive) { log(`using the sketchpad already running at ${BASE}`); return true }
  if (!AUTOSTART) { log(`no sketchpad at ${BASE} and autostart is off`); return false }
  if (!BASE.startsWith('http://127.0.0.1') && !BASE.startsWith('http://localhost')) {
    log(`no sketchpad at ${BASE}; it is not on this machine, so it cannot be started from here`)
    return false
  }

  log('no sketchpad running — starting one')
  const out = openSync(join(ROOT, '.sketchpad-server.log'), 'a')
  const child = spawn(process.execPath, [join(HERE, 'index.mjs')], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out]
  })
  child.unref()

  // Two clients can race to start it; whoever loses gets EADDRINUSE and exits, and finds the
  // winner's server here. So poll health rather than trusting our own child.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 400))
    if (await health(800)) { log('sketchpad is up'); return true }
  }
  log(`sketchpad did not come up within 16s — see ${join(ROOT, '.sketchpad-server.log')}`)
  return false
}

let upstream = null
async function connectUpstream() {
  if (upstream) return upstream
  const client = new Client({ name: 'sketchpad-stdio-proxy', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)))
  upstream = client
  return client
}
function dropUpstream() { try { upstream?.close() } catch {} upstream = null }

async function withUpstream(fn) {
  try {
    return await fn(await connectUpstream())
  } catch (err) {
    // One retry: the shared server may have been restarted under us.
    dropUpstream()
    await ensureServer()
    return await fn(await connectUpstream())
  }
}

const INSTRUCTIONS = 'A person is drawing on an iPad with a pencil. Call sketchpad_wait_for_turn to receive each turn: a PNG of their page (grey = strokes you already saw, dark = new since last turn) plus an optional handwritten note. Look at the image first. Answer with sketchpad_show: a short text; an svg in that image\'s pixel coordinates when a small drawn addition helps (it becomes editable strokes on their canvas); or image_path when you have rendered a diagram or generated an image (it becomes a layer they can move and draw over). Use sketchpad_list_turns / sketchpad_get_turn to look back at earlier versions. Name the page with sketchpad_set_title once you know what it is. Then wait for the next turn.'

const server = new Server({ name: 'sketchpad', version: '0.3.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return await withUpstream(c => c.listTools())
  } catch (err) {
    log('tools/list failed:', err.message)
    return { tools: [] }
  }
})

server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    // wait_for_turn blocks for up to ten minutes by design; don't let the proxy time it out.
    return await withUpstream(c => c.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }, undefined, { timeout: 660_000 }))
  } catch (err) {
    log('tools/call failed:', req.params.name, err.message)
    return { content: [{ type: 'text', text: `sketchpad is not reachable at ${BASE}: ${err.message}` }], isError: true }
  }
})

await ensureServer()
await server.connect(new StdioServerTransport())
log('ready')
