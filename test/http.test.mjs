// End to end over a real port: a real server process, a real MCP client, and a fake iPad on the
// WebSocket. This is the path both sides actually take.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { localFetch } from '../server/local-fetch.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8894
// The server serves TLS by default now, so the tests take the same path a real client does:
// verified against the certificate it wrote, not against the public CA list.
const BASE = `https://127.0.0.1:${PORT}`
const SKETCH = readFileSync(join(ROOT, 'test/fixtures/page.png')).toString('base64')
const TOKEN = 'test-token-not-a-secret'
const AUTH = { authorization: `Bearer ${TOKEN}` }

describe('over http', () => {
  let server, client, ipad, configDir, fetch

  const fromIPad = []

  before(async () => {
    // Its own config directory, so the suite never touches the token, certificate or paired
    // devices belonging to whoever is running it.
    configDir = mkdtempSync(join(tmpdir(), 'sketchpad-config-'))
    server = spawn('node', [join(ROOT, 'server/index.mjs')], {
      cwd: mkdtempSync(join(tmpdir(), 'sketchpad-http-')),
      env: {
        ...process.env,
        SKETCHPAD_PORT: String(PORT), SKETCHPAD_QUIET: '1', SKETCHPAD_NO_BONJOUR: '1',
        SKETCHPAD_TOKEN: TOKEN, SKETCHPAD_CONFIG_DIR: configDir
      },
      stdio: ['ignore', 'ignore', 'inherit']
    })

    // The certificate only exists once the server has written it.
    await waitFor(() => existsSync(join(configDir, 'cert.pem')), 'the server never wrote a certificate')
    const ca = readFileSync(join(configDir, 'cert.pem'), 'utf8')
    fetch = localFetch({ ca })
    await waitFor(async () => (await fetch(`${BASE}/health`, { headers: AUTH })).ok)

    // The iPad has no way to set headers on a WebSocket handshake it builds from a QR code, so the
    // token rides in the query string there.
    ipad = new WebSocket(`wss://127.0.0.1:${PORT}/ws?token=${TOKEN}`, { ca, checkServerIdentity: () => undefined })
    ipad.on('message', d => fromIPad.push(JSON.parse(d.toString())))
    await new Promise(r => ipad.on('open', r))

    client = new Client({ name: 'test-agent', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: AUTH },
      fetch: (input, init) => fetch(input, init)
    }))
  })

  after(async () => {
    await client?.close()
    ipad?.close()
    server?.kill()
    rmSync(configDir, { recursive: true, force: true })
  })

  const call = (name, args = {}) => client.callTool({ name, arguments: args })
  const textOf = r => r.content.find(c => c.type === 'text').text
  const seen = (type, where = () => true) => fromIPad.find(m => m.type === type && where(m))
  /// The iPad answering something the server asked it over the socket.
  const answer = body => fetch(`${BASE}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(body)
  })

  test('the iPad is greeted with the current state', () => {
    assert.equal(seen('hello')?.listening, false)
  })

  test('a page posted by the iPad reaches an agent, image and all', async () => {
    const waiting = call('sketchpad_wait_for_turn', { timeout_seconds: 10 })

    const posted = await fetch(`${BASE}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
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
    assert.equal((await fetch(`${BASE}/health`, { headers: AUTH }).then(r => r.json())).agent_listening, true)
    await waitFor(() => fromIPad.some(m => m.type === 'agents' && m.listening))
  })

  test('a reply reaches the iPad and is kept for replay', async () => {
    await call('sketchpad_show', { text: 'Account, password, a button.', svg: '<svg><rect/></svg>' })
    await waitFor(() => !!seen('reply'))
    assert.equal(seen('reply').text, 'Account, password, a button.')

    const replies = await fetch(`${BASE}/replies?since=0`, { headers: AUTH }).then(r => r.json())
    assert.equal(replies.at(-1).text, 'Account, password, a button.')
  })

  test('the canvas can be snapshotted on demand', async () => {
    const asked = call('sketchpad_get_canvas')
    await waitFor(() => !!seen('ask'))
    await answer({ id: seen('ask').id, png: `data:image/png;base64,${SKETCH}` })
    assert.equal((await asked).content.find(c => c.type === 'image').data, SKETCH)
  })

  test('the history comes from the iPad, not from here', async () => {
    const asked = call('sketchpad_list_turns', { board_id: 'all' })
    await waitFor(() => !!seen('ask', m => m.kind === 'list_turns'))
    const question = seen('ask', m => m.kind === 'list_turns')
    await answer({ id: question.id, turns: [{ turnId: 'kept-on-device', ts: 1, strokes: 4, text: 'from the iPad' }] })
    assert.match((await asked).content[0].text, /kept-on-device/)
  })

  test('naming the page reaches the iPad', async () => {
    await call('sketchpad_set_title', { title: 'Login flow' })
    await waitFor(() => !!seen('title'))
    assert.equal(seen('title').title, 'Login flow')
  })

  test('an unknown path still answers rather than hanging', async () => {
    const res = await fetch(`${BASE}/nothing-here`, { headers: AUTH })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Sketchpad is running/)
  })

  describe('a stranger on the same network', () => {
    test('is refused without the token', async () => {
      for (const path of ['/health', '/replies?since=0', '/turn', '/files/anything.png']) {
        assert.equal((await fetch(BASE + path)).status, 401, path)
      }
    })

    test('is refused with the wrong token', async () => {
      assert.equal((await fetch(`${BASE}/health?token=nearly-right`)).status, 401)
    })

    test('cannot open the iPad socket, so cannot mirror what is drawn', async () => {
      const rogue = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { rejectUnauthorized: false })
      const outcome = await new Promise(r => {
        rogue.on('open', () => r('open'))
        rogue.on('error', () => r('refused'))
      })
      assert.equal(outcome, 'refused')
    })
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
