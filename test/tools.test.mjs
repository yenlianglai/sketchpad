// The MCP surface, exercised through a real client over an in-memory transport: no ports, no
// spawning, but the same code path an agent takes.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createState } from '../server/state.mjs'
import { createDevices } from '../server/devices.mjs'
import { buildMcpServer, TOOLS } from '../server/tools.mjs'

const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

describe('tools', () => {
  let dir, sent, clients, state, client, server, ipad, devices

  /// Everything the server broadcasts, plus a stand-in iPad that answers what it is asked — the
  /// history lives on the device, so a test that looks back has to have one.
  const broadcast = m => {
    sent.push(m)
    if (m.type === 'ask') queueMicrotask(() => state.answer(m.id, ipad?.(m) ?? null))
  }

  async function connect() {
    state = createState({ broadcast, clientCount: () => clients, spoolDir: dir })
    devices = createDevices({ dir, fingerprint: () => 'test-certificate' })
    server = buildMcpServer({ state, broadcast, clientCount: () => clients, devices })
    const [a, b] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '0' })
    await Promise.all([server.connect(b), client.connect(a)])
  }

  const call = (name, args = {}) => client.callTool({ name, arguments: args })
  const textOf = r => r.content.find(c => c.type === 'text').text
  const imageOf = r => r.content.find(c => c.type === 'image')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sketchpad-tools-'))
    sent = []
    clients = 1
    ipad = null
    await connect()
  })
  afterEach(async () => {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('every documented tool is actually offered', async () => {
    const offered = (await client.listTools()).tools.map(t => t.name).sort()
    assert.deepEqual(offered, TOOLS.map(t => t.name).sort())
    assert.equal(offered.length, 4)
  })

  describe('wait_for_turn', () => {
    test('hands over the note, the page, and how to answer in kind', async () => {
      state.pushTurn({ turnId: 'abc', text: 'make this a form', strokes: 4, pngBase64: RED_PNG, pngPath: '/tmp/abc.png', boardTitle: 'Flow', ts: Date.now() })
      const result = await call('sketchpad_wait_for_turn', { timeout_seconds: 1 })
      const body = textOf(result)
      assert.match(body, /turn_id=abc/)
      assert.match(body, /note: make this a form/)
      assert.match(body, /new_strokes=4/)
      assert.match(body, /image_px=1x1/)
      assert.equal(imageOf(result).data, RED_PNG)
      assert.ok(sent.some(m => m.type === 'taken' && m.turnId === 'abc'), 'the iPad should be told it was read')
    })

    test('says so plainly when nothing arrives, without erroring', async () => {
      const result = await call('sketchpad_wait_for_turn', { timeout_seconds: 1 })
      assert.ok(!result.isError)
      assert.match(textOf(result), /no turn within 1s/)
    })

    test('the image can be left out', async () => {
      state.pushTurn({ turnId: 'd', pngBase64: RED_PNG, ts: Date.now() })
      const result = await call('sketchpad_wait_for_turn', { timeout_seconds: 1, include_image: false })
      assert.equal(imageOf(result), undefined)
    })

    test('an empty canvas is described, not hidden', async () => {
      state.pushTurn({ turnId: 'e', ts: Date.now() })
      assert.match(textOf(await call('sketchpad_wait_for_turn', { timeout_seconds: 1 })), /sketch: \(canvas empty\)/)
    })
  })

  describe('show', () => {
    test('text alone reaches the iPad', async () => {
      await call('sketchpad_show', { text: 'Looks like a login form.' })
      const reply = sent.find(m => m.type === 'reply')
      assert.equal(reply.text, 'Looks like a login form.')
      assert.deepEqual(reply.files, [])
    })

    test('svg rides along as an inline file the iPad turns into strokes', async () => {
      await call('sketchpad_show', { text: 'boxed it', svg: '<svg><rect/></svg>', turn_id: 't1' })
      const { files } = sent.find(m => m.type === 'reply')
      assert.equal(files[0].kind, 'sketch')
      assert.match(files[0].url, /^data:image\/svg\+xml;base64,/)
      assert.equal(Buffer.from(files[0].url.split(',')[1], 'base64').toString(), '<svg><rect/></svg>')
    })

    test('an image is published and labelled with its kind', async () => {
      const src = join(dir, 'flow.png')
      writeFileSync(src, 'bytes')
      await call('sketchpad_show', { text: 'diagram', image_path: src, kind: 'mermaid', place_as_layer: true })
      const { files } = sent.find(m => m.type === 'reply')
      assert.equal(files[0].kind, 'mermaid')
      assert.equal(files[0].layer, true)
      assert.match(files[0].url, /^\/files\//)
    })

    test('a bad path fails the call instead of the process', async () => {
      const result = await call('sketchpad_show', { text: 'x', image_path: '/no/such/file.png' })
      assert.equal(result.isError, true)
      assert.match(textOf(result), /sketchpad_show failed/)
    })

    test('the reply is held for an iPad that is not there to receive it', async () => {
      state.pushTurn({ turnId: 'p1', ts: Date.now() })
      await call('sketchpad_show', { text: 'remembered', turn_id: 'p1' })
      const [held] = state.repliesSince(0)
      assert.equal(held.text, 'remembered')
      assert.equal(held.turnId, 'p1')
    })

    test('it still goes through with no iPad connected, and says so', async () => {
      clients = 0
      assert.match(textOf(await call('sketchpad_show', { text: 'hi' })), /no iPad connected/)
    })
  })

  test('status carries a code to read out when nothing is connected', async () => {
    clients = 0
    const said = JSON.parse(textOf(await call('sketchpad_status')))
    assert.match(said.pairing_code, /^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/)
    assert.equal(devices.pendingCode(), said.pairing_code)
  })

  test('and reuses it, so asking twice does not invalidate one being typed', async () => {
    clients = 0
    const first = JSON.parse(textOf(await call('sketchpad_status'))).pairing_code
    assert.equal(JSON.parse(textOf(await call('sketchpad_status'))).pairing_code, first)
  })

  test('but not when an iPad is already there', async () => {
    assert.equal(JSON.parse(textOf(await call('sketchpad_status'))).pairing_code, undefined)
  })

  test('status reports what an agent needs to decide whether to wait', async () => {
    state.pushTurn({ turnId: 'q', ts: Date.now() })
    const status = JSON.parse(textOf(await call('sketchpad_status')))
    assert.equal(status.ipad_connected, true)
    assert.equal(status.pending_turns, 1)
    assert.equal(status.last_turn_id, 'q')
  })
})
