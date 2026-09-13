import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createState, pngSize, LISTEN_GRACE_MS, SPOOL_TTL_MS } from '../server/state.mjs'

describe('state', () => {
  let dir, sent, clients, state

  const make = (opts = {}) => createState({
    broadcast: m => sent.push(m),
    clientCount: () => clients,
    spoolDir: dir,
    ...opts
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sketchpad-'))
    sent = []
    clients = 1
    state = make()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const page = (id, extra = {}) => ({ turnId: id, text: '', strokes: 3, ts: 1000, ...extra })

  describe('the queue', () => {
    test('a page already waiting is handed over at once', async () => {
      state.pushTurn(page('a'))
      assert.equal((await state.takeTurn(50)).turnId, 'a')
      assert.equal(state.pending(), 0)
    })

    test('waiting resolves when a page arrives', async () => {
      const waiting = state.takeTurn(2000)
      state.pushTurn(page('b'))
      assert.equal((await waiting).turnId, 'b')
    })

    test('waiting gives up and returns null, without dropping a later page', async () => {
      assert.equal(await state.takeTurn(30), null)
      state.pushTurn(page('c'))
      assert.equal((await state.takeTurn(50)).turnId, 'c')
    })

    test('pages are handed out in order, one per waiter', async () => {
      const first = state.takeTurn(2000)
      state.pushTurn(page('d'))
      state.pushTurn(page('e'))
      assert.equal((await first).turnId, 'd')
      assert.equal((await state.takeTurn(50)).turnId, 'e')
    })
  })

  describe('the listening light', () => {
    test('turns on while an agent waits and reports the change once', async () => {
      assert.equal(state.isListening(), false)
      const waiting = state.takeTurn(60)
      assert.equal(state.isListening(), true)
      assert.deepEqual(sent.filter(m => m.type === 'agents'), [{ type: 'agents', listening: true }])
      await waiting
      // Still on: the grace period covers the gap between two polls.
      assert.equal(state.isListening(), true)
    })

    test('goes out once the grace period has passed', async () => {
      let clock = 1_000_000
      const s = make({ now: () => clock })
      await s.takeTurn(10)
      assert.equal(s.isListening(), true)
      clock += LISTEN_GRACE_MS + 1
      await s.takeTurn(10)          // any call re-evaluates
      assert.equal(s.isListening(), true, 'this call is itself a poll, so it stays on')
    })
  })

  describe('asking the iPad', () => {
    test('the question goes out and the answer comes back', async () => {
      const asked = state.listTurns({ boardId: 'all' })
      const question = sent.find(m => m.type === 'ask' && m.kind === 'list_turns')
      assert.ok(question, 'the iPad should have been asked')
      state.answer(question.id, { turns: [{ turnId: 'f', boardTitle: 'Flow' }] })
      assert.deepEqual((await asked).map(t => t.turnId), ['f'])
    })

    test('no iPad connected resolves immediately rather than hanging', async () => {
      clients = 0
      assert.equal(await state.requestSnapshot(5000), null)
      assert.equal(await state.listTurns(), null)
      assert.equal(sent.filter(m => m.type === 'ask').length, 0)
    })

    test('an unanswered question gives up', async () => {
      assert.equal(await state.requestSnapshot(30), null)
    })

    test('a snapshot is just another question', async () => {
      const asked = state.requestSnapshot(500)
      const question = sent.find(m => m.type === 'ask' && m.kind === 'canvas')
      state.answer(question.id, { png: 'AAAA' })
      assert.equal((await asked).png, 'AAAA')
    })

    test('the server keeps no history of its own', () => {
      state.pushTurn(page('f', { boardId: 'B', boardTitle: 'Flow' }))
      assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.json') && n !== 'undelivered.json'), [])
    })
  })

  describe('replies waiting for the iPad', () => {
    // Timestamps are real milliseconds, because anything older than a day is pruned.
    const at = n => Date.now() - (4 - n) * 1000

    test('replay returns only what came after, oldest first', () => {
      for (const id of ['r1', 'r2', 'r3']) {
        state.recordReply({ id, turnId: 'm', text: id, files: [], ts: at(Number(id[1])) })
      }
      assert.deepEqual(state.repliesSince(at(1) + 1).map(r => r.id), ['r2', 'r3'])
      assert.deepEqual(state.repliesSince(0).map(r => r.id), ['r1', 'r2', 'r3'])
      assert.deepEqual(state.repliesSince(Date.now() + 1000), [])
    })

    test('a replayed reply still says which page it belongs to', () => {
      state.recordReply({ id: 'r', turnId: 'n', text: '', files: [], ts: Date.now() })
      assert.equal(state.repliesSince(0)[0].turnId, 'n')
    })

    test('survive a restart, so a reply sent to a sleeping iPad is not lost', () => {
      state.recordReply({ id: 'r', turnId: 'n', text: 'later', files: [], ts: Date.now() })
      assert.deepEqual(make().repliesSince(0).map(r => r.id), ['r'])
    })

    test('are dropped once the iPad has had a day to collect them', () => {
      let clock = 10 * SPOOL_TTL_MS
      const s = make({ now: () => clock })
      s.recordReply({ id: 'old', turnId: 'n', text: '', files: [], ts: clock })
      clock += SPOOL_TTL_MS + 1
      assert.deepEqual(s.repliesSince(0), [])
    })
  })

  describe('files the agent hands over', () => {
    test('are spooled and served from a url', () => {
      const src = join(dir, 'diagram.png')
      writeFileSync(src, 'png-bytes')
      const published = state.publishFile(src)
      assert.equal(published.name, 'diagram.png')
      assert.match(published.url, /^\/files\/\d+-diagram\.png$/)
      assert.ok(existsSync(join(dir, 'files', published.url.replace('/files/', ''))))
    })

    test('a relative path says why, rather than failing as a missing file', () => {
      // A login item's working directory is wherever launchd or systemd left it, so a path relative
      // to the agent's own project resolves to nothing useful.
      assert.throws(() => state.publishFile('outputs/diagrams/flow.png'), /must be absolute/)
    })

    test('a type the iPad cannot show is refused', () => {
      const src = join(dir, 'notes.txt')
      writeFileSync(src, 'hello')
      assert.throws(() => state.publishFile(src), /unsupported file type \.txt/)
    })
  })

  describe('the open page', () => {
    test('follows whichever page the iPad last sent from', () => {
      state.pushTurn(page('o', { boardId: 'B9', boardTitle: 'Login flow' }))
      assert.deepEqual(state.currentBoard, { id: 'B9', title: 'Login flow' })
    })
  })
})

describe('pngSize', () => {
  test('reads the dimensions out of a PNG header', () => {
    // 1x1 red PNG
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
    assert.equal(pngSize(png), '1x1')
  })
  test('says so rather than throwing on rubbish', () => {
    assert.equal(pngSize('not base64 at all'), '?')
    assert.equal(pngSize(''), '?')
  })
})
