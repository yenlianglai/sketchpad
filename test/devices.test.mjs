// Pairing: a code that is good once, briefly, for one device — and a key per device so losing one
// iPad does not mean re-pairing everything.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDevices, CODE_TTL_MS } from '../server/devices.mjs'
import { makeAuthorizer } from '../server/auth.mjs'

describe('pairing', () => {
  let dir, clock, devices
  const make = () => createDevices({ dir, now: () => clock })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sketchpad-devices-'))
    clock = 1_700_000_000_000
    devices = make()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a code buys one device its own key', () => {
    const { code } = devices.mintCode()
    const paired = devices.redeem(code, 'Ryan’s iPad')
    assert.ok(paired.token.length >= 32)
    assert.equal(paired.name, 'Ryan’s iPad')
    assert.equal(devices.accepts(paired.token), true)
  })

  test('the code is spent, so a photo of the QR is worth nothing afterwards', () => {
    const { code } = devices.mintCode()
    assert.ok(devices.redeem(code, 'first'))
    assert.equal(devices.redeem(code, 'second'), null)
  })

  test('and expires on its own if nobody uses it', () => {
    const { code } = devices.mintCode()
    clock += CODE_TTL_MS + 1
    assert.equal(devices.redeem(code, 'late'), null)
  })

  test('a wrong code pairs nothing', () => {
    devices.mintCode()
    assert.equal(devices.redeem('not-the-code', 'x'), null)
    assert.equal(devices.redeem('', 'x'), null)
    assert.equal(devices.redeem(undefined, 'x'), null)
  })

  test('with no code outstanding, nothing can be redeemed', () => {
    assert.equal(devices.redeem('anything', 'x'), null)
  })

  test('minting again retires the code on the old QR', () => {
    const first = devices.mintCode().code
    devices.mintCode()
    assert.equal(devices.redeem(first, 'x'), null)
  })

  test('two iPads each get their own key', () => {
    const a = devices.redeem(devices.mintCode().code, 'iPad Pro')
    const b = devices.redeem(devices.mintCode().code, 'iPad mini')
    assert.notEqual(a.token, b.token)
    assert.equal(devices.list().length, 2)
  })
})

describe('revoking', () => {
  let dir, devices
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sketchpad-devices-'))
    devices = createDevices({ dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('takes one device away and leaves the others alone', () => {
    const gone = devices.redeem(devices.mintCode().code, 'lost iPad')
    const kept = devices.redeem(devices.mintCode().code, 'my iPad')
    assert.equal(devices.revoke(gone.id), true)
    assert.equal(devices.accepts(gone.token), false)
    assert.equal(devices.accepts(kept.token), true, 'revoking one must not re-pair the rest')
  })

  test('an id that is not there is not an error worth throwing over', () => {
    assert.equal(devices.revoke('nope'), false)
  })
})

describe('the device file', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sketchpad-devices-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('survives a restart, so a paired iPad stays paired', () => {
    const first = createDevices({ dir })
    const paired = first.redeem(first.mintCode().code, 'iPad')
    assert.equal(createDevices({ dir }).accepts(paired.token), true)
  })

  test('but an unspent code does not, because it only ever lived in one process', () => {
    const code = createDevices({ dir }).mintCode().code
    assert.equal(createDevices({ dir }).redeem(code, 'iPad'), null)
  })

  test('is readable only by its owner, because it holds keys', () => {
    const d = createDevices({ dir })
    d.redeem(d.mintCode().code, 'iPad')
    assert.equal(statSync(join(dir, 'devices.json')).mode & 0o077, 0)
  })

  test('never hands the keys back out in a listing', () => {
    const d = createDevices({ dir })
    d.redeem(d.mintCode().code, 'iPad')
    assert.equal(JSON.stringify(d.list()).includes('token'), false)
  })

  test('a file someone has mangled costs the pairings, not the ability to pair again', () => {
    writeFileSync(join(dir, 'devices.json'), 'not json')
    const d = createDevices({ dir })
    assert.deepEqual(d.list(), [])
    assert.ok(d.redeem(d.mintCode().code, 'iPad'))
  })

  test('is not written before anything is paired', () => {
    createDevices({ dir }).mintCode()
    assert.equal(existsSync(join(dir, 'devices.json')), false)
  })
})

describe('a paired device getting in', () => {
  let dir, devices, authorize
  const req = (token, from = '192.168.1.50') => ({
    method: 'GET', socket: { remoteAddress: from }, headers: { authorization: `Bearer ${token}` }
  })
  const at = path => new URL(`http://x${path}`)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sketchpad-devices-'))
    devices = createDevices({ dir })
    authorize = makeAuthorizer({ token: 'machine-token', devices })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('its own key is enough', () => {
    const paired = devices.redeem(devices.mintCode().code, 'iPad')
    assert.equal(authorize(req(paired.token), at('/turn')), true)
  })

  test('and the machine token still works, which is how the local wrapper gets in', () => {
    assert.equal(authorize(req('machine-token'), at('/turn')), true)
  })

  test('a revoked key stops working straight away', () => {
    const paired = devices.redeem(devices.mintCode().code, 'iPad')
    devices.revoke(paired.id)
    assert.equal(authorize(req(paired.token), at('/turn')), false)
  })

  test('a device key does not open the agent endpoint from the network', () => {
    const paired = devices.redeem(devices.mintCode().code, 'iPad')
    assert.equal(authorize(req(paired.token), at('/mcp')), false)
  })

  test('pairing itself is reachable without a key, because that is how you get one', () => {
    const post = { method: 'POST', socket: { remoteAddress: '192.168.1.50' }, headers: {} }
    assert.equal(authorize(post, at('/pair')), true)
    assert.equal(authorize({ ...post, method: 'GET' }, at('/pair')), false, 'reading the QR still needs a key')
  })
})
