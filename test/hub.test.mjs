// Noticing that an iPad has gone.
//
// A socket only fires `close` when the other end closes it politely. One that goes out of range,
// sleeps or is killed leaves a half-open connection behind — and until this, that connection stayed
// in the set for as long as the operating system kept it. Agents were told an iPad was there, pages
// were broadcast into nothing, and a canvas snapshot waited out its timeout for a device that left.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHub, HEARTBEAT_MS } from '../server/hub.mjs'

/// A stand-in iPad. Answers pings until `answers` is turned off, which is what going out of range
/// looks like from this end: the socket is still open and still writable, and nothing comes back.
function fakeSocket({ answers = true } = {}) {
  const handlers = {}
  return {
    readyState: 1, sent: [], terminated: false, answers,
    send(json) { this.sent.push(JSON.parse(json)) },
    on(event, fn) { handlers[event] = fn },
    emit(event) { handlers[event]?.() },
    ping() { if (this.answers) this.emit('pong') },
    terminate() { this.terminated = true }
  }
}

describe('watching a connected iPad', () => {
  let clock, hub
  const beat = 20_000
  beforeEach(() => {
    clock = 1_700_000_000_000
    hub = createHub({ now: () => clock, heartbeatMs: beat })
  })

  test('one that answers is kept', () => {
    const ws = hub.track(fakeSocket())
    for (let i = 0; i < 5; i++) { clock += beat; hub.sweep() }
    assert.equal(hub.clientCount(), 1)
    assert.equal(ws.terminated, false)
  })

  test('one that stops answering is dropped, not counted forever', () => {
    const ws = hub.track(fakeSocket())
    ws.answers = false                 // out of range: still open, nothing comes back
    hub.sweep()                        // one unanswered ping is not enough to condemn it
    assert.equal(hub.clientCount(), 1)
    hub.sweep()
    assert.equal(hub.clientCount(), 0, 'agents would otherwise be told it is there')
    assert.equal(ws.terminated, true, 'and the socket left open')
  })

  test('a live one is not dropped along with a dead one', () => {
    const alive = hub.track(fakeSocket())
    const gone = hub.track(fakeSocket({ answers: false }))
    hub.sweep()                        // both pinged; only one answers
    hub.sweep()
    assert.equal(hub.clientCount(), 1)
    assert.equal(alive.terminated, false)
    assert.equal(gone.terminated, true)
  })

  test('a sweep that ran late does not condemn everyone', () => {
    // The judgement is whether the last ping was answered, not how long ago. Wall-clock time would
    // drop every healthy socket the first time this did not run on schedule.
    const ws = hub.track(fakeSocket())
    clock += beat * 20                 // the process was asleep
    hub.sweep()
    assert.equal(hub.clientCount(), 1)
    assert.equal(ws.terminated, false)
  })

  test('says how long since the last word, so "connected" can be qualified', () => {
    hub.track(fakeSocket())
    assert.equal(hub.quietFor(), 0)
    clock += 5_000
    assert.equal(hub.quietFor(), 5_000)
    hub.sweep()                        // answered: the clock restarts
    assert.equal(hub.quietFor(), 0)
  })

  test('and nothing at all when nothing is connected', () => {
    assert.equal(hub.quietFor(), null)
    assert.equal(hub.clientCount(), 0)
  })

  test('a closed socket leaves the set the ordinary way too', () => {
    const ws = hub.track(fakeSocket())
    ws.emit('close')
    assert.equal(hub.clientCount(), 0)
  })

  test('a message counts as proof of life, not just a pong', () => {
    const ws = hub.track(fakeSocket({ answers: false }))
    hub.sweep()                        // pinged, no pong coming
    ws.emit('message')                 // but it spoke, which settles it
    hub.sweep()
    assert.equal(hub.clientCount(), 1, 'an iPad that is talking is plainly there')
  })

  test('the heartbeat is frequent enough to matter', () => {
    assert.ok(HEARTBEAT_MS <= 30_000, 'a minute of believing a departed iPad is there is too long')
  })
})
