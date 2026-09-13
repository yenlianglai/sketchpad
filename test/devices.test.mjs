// Pairing: a code that is good once, briefly, for one device — and a key per device so losing one
// iPad does not mean re-pairing everything.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDevices, proofFor, formatCode, normalizeCode, CODE_TTL_MS } from '../server/devices.mjs'
import { makeAuthorizer } from '../server/auth.mjs'

const CERT = 'a-certificate-fingerprint'
/// What an iPad sends: the proof, never the code.
const asIPad = (devices, code, name = 'iPad', cert = CERT) => devices.redeem(proofFor(code, cert), name)
/// One line for the common case of minting and immediately redeeming.
const pairOne = (devices, name = 'iPad') => asIPad(devices, devices.mintCode().code, name)

describe('pairing', () => {
  let dir, clock, devices
  const make = () => createDevices({ dir, now: () => clock, fingerprint: () => CERT })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sketchpad-devices-'))
    clock = 1_700_000_000_000
    devices = make()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a code buys one device its own key', () => {
    const { code } = devices.mintCode()
    const paired = asIPad(devices, code, 'Ryan’s iPad')
    assert.ok(paired.token.length >= 32)
    assert.equal(paired.name, 'Ryan’s iPad')
    assert.equal(devices.accepts(paired.token), true)
  })

  test('the code is spent, so reading it out twice pairs only once', () => {
    const { code } = devices.mintCode()
    assert.ok(asIPad(devices, code, 'first'))
    assert.equal(asIPad(devices, code, 'second'), null)
  })

  test('a proof against someone else\'s certificate is refused', () => {
    // The whole reason eight typed characters are enough: a man in the middle necessarily presents
    // a different certificate, so the proof the iPad computes does not match this server's.
    const { code } = devices.mintCode()
    assert.equal(asIPad(devices, code, 'impostor', 'a-different-certificate'), null)
    assert.ok(asIPad(devices, code, 'the real one'), 'and the honest one still works')
  })

  test('the code itself is not accepted in place of a proof', () => {
    const { code } = devices.mintCode()
    assert.equal(devices.redeem(code, 'x'), null)
  })

  test('the code is readable and unambiguous', () => {
    const { code, formatted } = devices.mintCode()
    assert.match(code, /^[0-9A-HJ-NP-TV-Z]{8}$/, 'no I, L, O or U — misread on screen, misheard aloud')
    assert.equal(formatted, `${code.slice(0, 4)}-${code.slice(4)}`)
  })

  test('typing it back in any reasonable shape still works', () => {
    const { code, formatted } = devices.mintCode()
    assert.equal(normalizeCode(formatted.toLowerCase()), code)
    assert.equal(normalizeCode(` ${formatted} `), code)
    assert.equal(formatCode(code.toLowerCase()), formatted)
  })

  test('and expires on its own if nobody uses it', () => {
    const { code } = devices.mintCode()
    clock += CODE_TTL_MS + 1
    assert.equal(asIPad(devices, code, 'late'), null)
  })

  test('a wrong code pairs nothing', () => {
    devices.mintCode()
    assert.equal(asIPad(devices, 'NOTTHEC0', 'x'), null)
    assert.equal(devices.redeem('', 'x'), null)
    assert.equal(devices.redeem(undefined, 'x'), null)
  })

  test('with no code outstanding, nothing can be redeemed', () => {
    assert.equal(asIPad(devices, 'ANYTHING', 'x'), null)
  })

  test('asking for another code retires the one already on screen', () => {
    const first = devices.mintCode().code
    devices.mintCode()
    assert.equal(asIPad(devices, first, 'x'), null)
  })

  test('two iPads each get their own key', () => {
    const a = pairOne(devices, 'iPad Pro')
    const b = pairOne(devices, 'iPad mini')
    assert.notEqual(a.token, b.token)
    assert.equal(devices.list().length, 2)
  })
})

describe('revoking', () => {
  let dir, devices
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sketchpad-devices-'))
    devices = createDevices({ dir, fingerprint: () => CERT })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('takes one device away and leaves the others alone', () => {
    const gone = pairOne(devices, 'lost iPad')
    const kept = pairOne(devices, 'my iPad')
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
    const first = createDevices({ dir, fingerprint: () => CERT })
    const paired = pairOne(first)
    assert.equal(createDevices({ dir }).accepts(paired.token), true)
  })

  test('but an unspent code does not, because it only ever lived in one process', () => {
    const code = createDevices({ dir, fingerprint: () => CERT }).mintCode().code
    assert.equal(asIPad(createDevices({ dir, fingerprint: () => CERT }), code, 'iPad'), null)
  })

  test('is readable only by its owner, because it holds keys', () => {
    const d = createDevices({ dir, fingerprint: () => CERT })
    pairOne(d)
    assert.equal(statSync(join(dir, 'devices.json')).mode & 0o077, 0)
  })

  test('never hands the keys back out in a listing', () => {
    const d = createDevices({ dir, fingerprint: () => CERT })
    pairOne(d)
    assert.equal(JSON.stringify(d.list()).includes('token'), false)
  })

  test('a file someone has mangled costs the pairings, not the ability to pair again', () => {
    writeFileSync(join(dir, 'devices.json'), 'not json')
    const d = createDevices({ dir, fingerprint: () => CERT })
    assert.deepEqual(d.list(), [])
    assert.ok(pairOne(d))
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
    devices = createDevices({ dir, fingerprint: () => CERT })
    authorize = makeAuthorizer({ token: 'machine-token', devices })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('its own key is enough', () => {
    const paired = pairOne(devices)
    assert.equal(authorize(req(paired.token), at('/turn')), true)
  })

  test('and the machine token still works, which is how the local wrapper gets in', () => {
    assert.equal(authorize(req('machine-token'), at('/turn')), true)
  })

  test('a revoked key stops working straight away', () => {
    const paired = pairOne(devices)
    devices.revoke(paired.id)
    assert.equal(authorize(req(paired.token), at('/turn')), false)
  })

  test('a device key does not open the agent endpoint from the network', () => {
    const paired = pairOne(devices)
    assert.equal(authorize(req(paired.token), at('/mcp')), false)
  })

  test('pairing itself is reachable without a key, because that is how you get one', () => {
    const post = { method: 'POST', socket: { remoteAddress: '192.168.1.50' }, headers: {} }
    assert.equal(authorize(post, at('/pair')), true)
    assert.equal(authorize({ ...post, method: 'GET' }, at('/pair')), false, 'reading the QR still needs a key')
  })
})
