// The stdio wrapper, driven exactly as Claude Desktop, Cursor or Codex would drive it: spawn the
// command, speak MCP over its stdin and stdout. It should find or start the shared server itself.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8895

describe('over stdio', () => {
  let client, transport

  before(async () => {
    transport = new StdioClientTransport({
      command: 'node',
      args: [join(ROOT, 'server/mcp-stdio.mjs')],
      env: {
        ...process.env,
        SKETCHPAD_URL: `http://127.0.0.1:${PORT}`,
        SKETCHPAD_PORT: String(PORT),
        SKETCHPAD_QUIET: '1',
        SKETCHPAD_NO_BONJOUR: '1'
      },
      stderr: 'ignore'
    })
    client = new Client({ name: 'test-any-agent', version: '0' })
    await client.connect(transport)
  })

  after(async () => {
    await client?.close()
    // The wrapper starts the shared server detached on purpose, so several clients can use one.
    // That means this test has to clean it up itself.
    try {
      const pids = execFileSync('lsof', ['-t', `-i:${PORT}`], { encoding: 'utf8' }).trim().split('\n')
      for (const pid of pids) if (pid) process.kill(Number(pid))
    } catch { /* already gone */ }
  })

  test('it starts the shared server and forwards the tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name)
    assert.ok(names.includes('sketchpad_wait_for_turn'))
    assert.equal(names.length, 7)
  })

  test('a call reaches the shared state, not a private copy', async () => {
    const status = JSON.parse((await client.callTool({ name: 'sketchpad_status', arguments: {} })).content[0].text)
    assert.equal(typeof status.pending_turns, 'number')

    const direct = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json())
    assert.equal(direct.ok, true)
  })

  test('waiting with nothing queued returns, rather than hanging the agent', async () => {
    const result = await client.callTool({ name: 'sketchpad_wait_for_turn', arguments: { timeout_seconds: 1 } })
    assert.match(result.content[0].text, /no turn within 1s/)
  })
})
