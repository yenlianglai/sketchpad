// End to end over a real port: a real server process, a real MCP client, and a fake iPad on the
// WebSocket. This is the path both sides actually take.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8894
const BASE = `http://127.0.0.1:${PORT}`
const SKETCH = readFileSync(join(ROOT, 'test/fixtures/page.png')).toString('base64')

describe('over http', () => {
  let server, client, ipad
  const fromIPad = []

  before(async () => {
    server = spawn('node', [join(ROOT, 'server/index.mjs')], {
      cwd: mkdtempSync(join(tmpdir(), 'sketchpad-http-')),
      env: { ...process.env, SKETCHPAD_PORT: String(PORT), SKETCHPAD_QUIET: '1', SKETCHPAD_NO_BONJOUR: '1' },
      stdio: ['ignore', 'ignore', 'inherit']
    })
    await waitFor(async () => (await fetch(`${BASE}/health`)).ok)

    ipad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    ipad.on('message', d => fromIPad.push(JSON.parse(d.toString())))
    await new Promise(r => ipad.on('open', r))

    client = new Client({ name: 'test-agent', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)))
  })

  after(async () => {
    await client?.close()
    ipad?.close()
    server?.kill()
  })

  const call = (name, args = {}) => client.callTool({ name, arguments: args })
  const textOf = r => r.content.find(c => c.type === 'text').text
  const seen = type => fromIPad.find(m => m.type === type)

  test('the iPad is greeted with the current state', () => {
    assert.equal(seen('hello')?.listening, false)
  })

  test('a page posted by the iPad reaches an agent, image and all', async () => {
    const waiting = call('sketchpad_wait_for_turn', { timeout_seconds: 10 })

    const posted = await fetch(`${BASE}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'make this a login form', png: `data:image/png;base64,${SKETCH}`, strokes: 4, boardId: 'B1', boardTitle: 'Flow' })
    }).then(r => r.json())
    assert.match(posted.turnId, /^[0-9a-f]{8}$/)

    const result = await waiting
    assert.match(textOf(result), /note: make this a login form/)
    assert.match(textOf(result), /page="Flow"/)
    const image = result.content.find(c => c.type === 'image')
    assert.equal(image.mimeType, 'image/png')
    assert.equal(image.data, SKETCH)

    await waitFor(() => !!seen('taken'), 'the iPad should learn the page was read')
  })

  test('the agent is reported as listening once it has waited', async () => {
    assert.equal((await fetch(`${BASE}/health`).then(r => r.json())).agent_listening, true)
    await waitFor(() => fromIPad.some(m => m.type === 'agents' && m.listening))
  })

  test('a reply reaches the iPad and is kept for replay', async () => {
    await call('sketchpad_show', { text: 'Account, password, a button.', svg: '<svg><rect/></svg>' })
    await waitFor(() => !!seen('reply'))
    assert.equal(seen('reply').text, 'Account, password, a button.')

    const replies = await fetch(`${BASE}/replies?since=0`).then(r => r.json())
    assert.equal(replies.at(-1).text, 'Account, password, a button.')
  })

  test('the canvas can be snapshotted on demand', async () => {
    const asked = call('sketchpad_get_canvas')
    await waitFor(() => !!seen('snapshot_request'))
    await fetch(`${BASE}/snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: seen('snapshot_request').id, png: `data:image/png;base64,${SKETCH}` })
    })
    assert.equal((await asked).content.find(c => c.type === 'image').data, SKETCH)
  })

  test('naming the page reaches the iPad', async () => {
    await call('sketchpad_set_title', { title: 'Login flow' })
    await waitFor(() => !!seen('title'))
    assert.equal(seen('title').title, 'Login flow')
  })

  test('the page is on disk, readable without this process', async () => {
    const rows = textOf(await call('sketchpad_list_turns', { board_id: 'all' }))
    assert.match(rows, /make this a login form/)
  })

  test('an unknown path still answers rather than hanging', async () => {
    const res = await fetch(`${BASE}/nothing-here`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Sketchpad is running/)
  })
})

async function waitFor(predicate, message = 'condition not met in time', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50))
  }
  assert.fail(message)
}
