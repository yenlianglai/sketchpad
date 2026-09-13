// Who gets in. These are the tests that matter most: every one of them is a thing that used to be
// allowed, back when the token was optional and /mcp answered anyone on the network.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadOrCreateToken, makeAuthorizer, presentedToken, sameSecret, isLoopback } from '../server/auth.mjs'

const req = ({ from = '127.0.0.1', token } = {}) => ({
  socket: { remoteAddress: from },
  headers: token ? { authorization: `Bearer ${token}` } : {}
})
const at = (path, query = '') => new URL(`http://x${path}${query}`)

describe('the token', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sketchpad-auth-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('is created on first run, so there is no unprotected default', () => {
    const { token, source } = loadOrCreateToken({ dir, env: {} })
    assert.equal(source, 'new')
    assert.ok(token.length >= 32, 'long enough not to be guessed')
  })

  test('is the same one next time', () => {
    const first = loadOrCreateToken({ dir, env: {} }).token
    const again = loadOrCreateToken({ dir, env: {} })
    assert.equal(again.token, first)
    assert.equal(again.source, 'saved')
  })

  test('is readable only by its owner', () => {
    loadOrCreateToken({ dir, env: {} })
    assert.equal(statSync(join(dir, 'token')).mode & 0o077, 0, 'no group or world access')
  })

  test('the environment wins, for a server someone is configuring themselves', () => {
    assert.deepEqual(loadOrCreateToken({ dir, env: { SKETCHPAD_TOKEN: 'mine' } }), { token: 'mine', source: 'environment' })
  })

  test('can be switched off deliberately, but only deliberately', () => {
    assert.deepEqual(loadOrCreateToken({ dir, env: { SKETCHPAD_NO_TOKEN: '1' } }), { token: '', source: 'disabled' })
  })

  test('an empty file is replaced rather than trusted', () => {
    writeFileSync(join(dir, 'token'), '\n')
    assert.equal(loadOrCreateToken({ dir, env: {} }).source, 'new')
    assert.ok(readFileSync(join(dir, 'token'), 'utf8').trim().length > 0)
  })
})

describe('reading the token off a request', () => {
  test('prefers the bearer header, which does not end up in logs', () => {
    assert.equal(presentedToken(req({ token: 'abc' }), at('/turn', '?token=stale')), 'abc')
  })

  test('falls back to the query string, which is all a QR-built WebSocket URL can carry', () => {
    assert.equal(presentedToken(req(), at('/ws', '?token=abc')), 'abc')
  })

  test('is empty when nothing is presented', () => {
    assert.equal(presentedToken(req(), at('/turn')), '')
  })
})

describe('comparing secrets', () => {
  test('accepts a match and rejects everything else', () => {
    assert.equal(sameSecret('abc', 'abc'), true)
    assert.equal(sameSecret('abc', 'abd'), false)
    assert.equal(sameSecret('abc', 'abcd'), false, 'a prefix is not a match')
    assert.equal(sameSecret('', 'abc'), false)
  })
})

describe('who is allowed in', () => {
  const authorize = makeAuthorizer({ token: 'secret' })

  test('the iPad routes need the token', () => {
    assert.equal(authorize(req({ from: '192.168.1.50' }), at('/turn')), false)
    assert.equal(authorize(req({ from: '192.168.1.50', token: 'secret' }), at('/turn')), true)
  })

  test('a wrong token is no better than none', () => {
    assert.equal(authorize(req({ from: '192.168.1.50', token: 'Secret' }), at('/turn')), false)
  })

  describe('/mcp', () => {
    test('is not reachable from the network at all, token or not', () => {
      assert.equal(authorize(req({ from: '192.168.1.50', token: 'secret' }), at('/mcp')), false)
    })

    test('is reachable from this machine, which is where the agent runs', () => {
      for (const from of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        assert.equal(authorize(req({ from, token: 'secret' }), at('/mcp')), true, from)
      }
    })

    test('still wants the token from this machine', () => {
      assert.equal(authorize(req({ from: '127.0.0.1' }), at('/mcp')), false)
    })

    test('can be opened up on purpose, for a server run on another box', () => {
      const open = makeAuthorizer({ token: 'secret', allowRemoteMCP: true })
      assert.equal(open(req({ from: '192.168.1.50', token: 'secret' }), at('/mcp')), true)
    })
  })

  test('with the token switched off, the network is let in — that is what it means', () => {
    const none = makeAuthorizer({ token: '' })
    assert.equal(none(req({ from: '192.168.1.50' }), at('/turn')), true)
    assert.equal(none(req({ from: '192.168.1.50' }), at('/mcp')), false, 'except /mcp, which is still local-only')
  })
})

describe('isLoopback', () => {
  test('tells this machine from the network', () => {
    assert.equal(isLoopback(req({ from: '127.0.0.1' })), true)
    assert.equal(isLoopback(req({ from: '192.168.1.50' })), false)
    assert.equal(isLoopback({}), false, 'a socket with no address is not this machine')
  })
})
