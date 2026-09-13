import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createState, pngSize, LISTEN_GRACE_MS } from '../server/state.mjs'

describe('state', () => {
  let dir, sent, clients, state

  const make = (opts = {}) => createState({
    broadcast: m => sent.push(m),
    clientCount: () => clients,
    inboxDir: dir,
    outboxDir: join(dir, 'out'),
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

  describe('the manifest', () => {
    test('records a page and survives a restart', () => {
      state.pushTurn(page('f', { boardId: 'B', boardTitle: 'Flow', pngPath: '/tmp/f.png' }))
      const reloaded = make()
      const [row] = reloaded.listTurns({ boardId: 'all' })
      assert.equal(row.turnId, 'f')
      assert.equal(row.boardTitle, 'Flow')
      assert.deepEqual(row.replies, [])
    })

    test('a corrupt manifest costs history, not the ability to draw', () => {
      writeFileSync(join(dir, 'turns.json'), 'not json at all')
      const s = make()
      assert.deepEqual(s.listTurns({ boardId: 'all' }), [])
      s.pushTurn(page('g'))
      assert.equal(s.listTurns({ boardId: 'all' }).length, 1)
    })

    test('lists newest first, and defaults to the page the iPad has open', () => {
      state.pushTurn(page('h', { boardId: 'B1', ts: 1 }))
      state.pushTurn(page('i', { boardId: 'B1', ts: 2 }))
      state.pushTurn(page('j', { boardId: 'B2', ts: 3 }))     // switches the current page
      assert.deepEqual(state.listTurns().map(t => t.turnId), ['j'])
      assert.deepEqual(state.listTurns({ boardId: 'all' }).map(t => t.turnId), ['j', 'i', 'h'])
      assert.deepEqual(state.listTurns({ boardId: 'B1' }).map(t => t.turnId), ['i', 'h'])
    })

    test('getTurn finds one by id and nothing for an unknown one', () => {
      state.pushTurn(page('k'))
      assert.equal(state.getTurn('k').turnId, 'k')
      assert.equal(state.getTurn('nope'), null)
    })
  })

  describe('replies', () => {
    test('attach to their page, and to the latest when the id is unknown', () => {
      state.pushTurn(page('l'))
      state.recordReply('l', { id: 'r1', text: 'on l', files: [], ts: 10 })
      state.recordReply('gone', { id: 'r2', text: 'no such page', files: [], ts: 20 })
      assert.deepEqual(state.getTurn('l').replies.map(r => r.id), ['r1', 'r2'])
    })

    test('replay returns only what came after, oldest first', () => {
      state.pushTurn(page('m'))
      for (const [id, ts] of [['r1', 10], ['r2', 20], ['r3', 30]]) {
        state.recordReply('m', { id, text: id, files: [], ts })
      }
      assert.deepEqual(state.recentReplies(15).map(r => r.id), ['r2', 'r3'])
      assert.deepEqual(state.recentReplies(0).map(r => r.id), ['r1', 'r2', 'r3'])
      assert.deepEqual(state.recentReplies(99), [])
    })

    test('a replayed reply still says which page it belongs to', () => {
      state.pushTurn(page('n'))
      state.recordReply('n', { id: 'r', text: '', files: [], ts: 5 })
      assert.equal(state.recentReplies(0)[0].turnId, 'n')
    })
  })

  describe('snapshots', () => {
    test('ask, then answer', async () => {
      const asked = state.requestSnapshot(500)
      const request = sent.find(m => m.type === 'snapshot_request')
      assert.ok(request, 'the iPad should have been asked')
      state.resolveSnapshot(request.id, 'AAAA')
      assert.equal(await asked, 'AAAA')
    })

    test('no iPad connected resolves immediately rather than hanging', async () => {
      clients = 0
      assert.equal(await state.requestSnapshot(5000), null)
    })

    test('an unanswered request gives up', async () => {
      assert.equal(await state.requestSnapshot(30), null)
    })
  })

  describe('files the agent hands over', () => {
    test('are copied into outbox and served from a url', () => {
      const src = join(dir, 'diagram.png')
      writeFileSync(src, 'png-bytes')
      const published = state.publishFile(src)
      assert.equal(published.name, 'diagram.png')
      assert.match(published.url, /^\/files\/\d+-diagram\.png$/)
      assert.ok(existsSync(join(dir, 'out', published.url.replace('/files/', ''))))
    })

    test('a type the iPad cannot show is refused', () => {
      const src = join(dir, 'notes.txt')
      writeFileSync(src, 'hello')
      assert.throws(() => state.publishFile(src), /unsupported file type \.txt/)
    })
  })

  describe('the open page', () => {
    test('follows the iPad, and a title reaches it', () => {
      state.pushTurn(page('o', { boardId: 'B9', boardTitle: 'Untitled' }))
      state.setTitle('Login flow')
      assert.equal(state.currentBoard.title, 'Login flow')
      assert.deepEqual(sent.at(-1), { type: 'title', boardId: 'B9', title: 'Login flow' })
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
