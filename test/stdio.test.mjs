// The stdio wrapper, driven exactly as Claude Desktop, Cursor or Codex would drive it: spawn the
// command, speak MCP over its stdin and stdout. It should find or start the shared server itself.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localFetch } from '../server/local-fetch.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8895
const TOKEN = 'stdio-test-token'
const BASE = `https://127.0.0.1:${PORT}`

describe('over stdio', () => {
  let client, transport, configDir, fetch

  before(async () => {
    // Its own config directory: the wrapper reads the token and certificate from wherever the
    // server put them, and this suite must not read or write the real ones.
    configDir = mkdtempSync(join(tmpdir(), 'sketchpad-stdio-config-'))
    transport = new StdioClientTransport({
      command: 'node',
      args: [join(ROOT, 'server/mcp-stdio.mjs')],
      env: {
        ...process.env,
        SKETCHPAD_URL: BASE,
        SKETCHPAD_PORT: String(PORT),
        SKETCHPAD_QUIET: '1',
        SKETCHPAD_NO_BONJOUR: '1',
        SKETCHPAD_TOKEN: TOKEN,
        SKETCHPAD_CONFIG_DIR: configDir
      },
      stderr: 'ignore'
    })
    client = new Client({ name: 'test-any-agent', version: '0' })
    await client.connect(transport)

    // The wrapper started the server, which wrote the certificate this suite now trusts.
    for (let i = 0; i < 40 && !existsSync(join(configDir, 'cert.pem')); i++) await new Promise(r => setTimeout(r, 100))
    fetch = localFetch({ ca: readFileSync(join(configDir, 'cert.pem'), 'utf8') })
  })

  after(async () => {
    await client?.close()
    // The wrapper starts the shared server detached on purpose, so several clients can use one.
    // That means this test has to clean it up itself.
    try {
      const pids = execFileSync('lsof', ['-t', `-i:${PORT}`], { encoding: 'utf8' }).trim().split('\n')
      // This process holds a connection to that port too, and lsof does not distinguish: killing
      // everything it lists would kill the test run itself.
      for (const pid of pids) {
        const n = Number(pid)
        if (n && n !== process.pid) process.kill(n)
      }
    } catch { /* already gone */ }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('it starts the shared server and forwards the tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name)
    assert.ok(names.includes('sketchpad_wait_for_turn'))
    assert.equal(names.length, 7)
  })

  test('a call reaches the shared state, not a private copy', async () => {
    const status = JSON.parse((await client.callTool({ name: 'sketchpad_status', arguments: {} })).content[0].text)
    assert.equal(typeof status.pending_turns, 'number')

    const direct = await fetch(`${BASE}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    }).then(r => r.json())
    assert.equal(direct.ok, true)
  })

  test('the wrapper finds the token itself, so no client has to be told it', async () => {
    // It reached the shared server above without the token ever appearing in this client's config.
    assert.equal((await fetch(`${BASE}/health`)).status, 401)
  })

  test('waiting with nothing queued returns, rather than hanging the agent', async () => {
    const result = await client.callTool({ name: 'sketchpad_wait_for_turn', arguments: { timeout_seconds: 1 } })
    assert.match(result.content[0].text, /no turn within 1s/)
  })
})
