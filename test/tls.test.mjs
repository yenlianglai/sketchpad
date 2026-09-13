// The certificate, and the fingerprint that makes a self-signed one safe to trust.
//
// Nobody can issue a certificate for a laptop on a home network, so the server signs its own and
// the QR carries its fingerprint. If the fingerprint in the QR ever stopped matching the
// certificate being served, the iPad would refuse to connect at all — or, worse, stop checking.

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadOrCreateCert, fingerprint } from '../server/tls.mjs'
import { pairing } from '../server/pairing.mjs'

describe('the certificate', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sketchpad-tls-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('is made on first run and kept afterwards', async () => {
    const first = await loadOrCreateCert({ dir, hosts: ['192.168.1.5'] })
    assert.equal(first.source, 'new')
    const again = await loadOrCreateCert({ dir, hosts: ['192.168.1.5'] })
    assert.equal(again.source, 'saved')
    assert.equal(again.fingerprint, first.fingerprint, 'a changed fingerprint would lock out every paired iPad')
  })

  test('covers the addresses the iPad will dial', async () => {
    const { cert } = await loadOrCreateCert({ dir, hosts: ['192.168.1.5'] })
    const san = new X509Certificate(cert).subjectAltName
    assert.match(san, /IP Address:192\.168\.1\.5/)
    assert.match(san, /IP Address:127\.0\.0\.1/)
    assert.match(san, /DNS:localhost/)
  })

  test('is replaced when the machine moves to an address it does not cover', async () => {
    const home = await loadOrCreateCert({ dir, hosts: ['192.168.1.5'] })
    const cafe = await loadOrCreateCert({ dir, hosts: ['10.0.0.9'] })
    assert.equal(cafe.source, 'new')
    assert.notEqual(cafe.fingerprint, home.fingerprint)
  })

  test('the private key is readable only by its owner', async () => {
    await loadOrCreateCert({ dir, hosts: [] })
    assert.equal(statSync(join(dir, 'key.pem')).mode & 0o077, 0)
  })

  test('lasts long enough not to lock people out of their own iPad', async () => {
    const { cert } = await loadOrCreateCert({ dir, hosts: [] })
    const years = (new Date(new X509Certificate(cert).validTo) - Date.now()) / (365 * 24 * 3600 * 1000)
    assert.ok(years > 5, `expires in ${years.toFixed(1)} years`)
  })

  test('a damaged certificate is replaced rather than served', async () => {
    await loadOrCreateCert({ dir, hosts: [] })
    writeFileSync(join(dir, 'cert.pem'), 'not a certificate')
    assert.equal((await loadOrCreateCert({ dir, hosts: [] })).source, 'new')
  })
})

describe('the fingerprint', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sketchpad-tls-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('is the sha256 of the certificate, in the form the iPad compares against', async () => {
    const { cert, fingerprint: fp } = await loadOrCreateCert({ dir, hosts: [] })
    assert.equal(fp, fingerprint(cert))
    assert.match(fp, /^[0-9a-f]{64}$/, 'lowercase hex, no colons — the app compares it as a string')
  })

  test('is never sent to the iPad, because it is what pairing proves', async () => {
    // The iPad learns the certificate from the handshake and binds its proof to it. Handing the
    // fingerprint over in the clear would make it something an attacker could simply repeat.
    const { fingerprint: fp } = await loadOrCreateCert({ dir, hosts: ['192.168.1.5'] })
    const info = pairing({ host: '192.168.1.5', port: 8791, code: 'V4XY-PE72' })
    assert.equal(JSON.stringify(info).includes(fp), false)
  })
})

describe('what the iPad is told', () => {
  test('is the code and where to find the Mac, and nothing secret', () => {
    const info = pairing({ host: '192.168.1.5', port: 8791, code: 'V4XY-PE72', expiresAt: 123 })
    assert.deepEqual(Object.keys(info).sort(), ['alt', 'code', 'expiresAt', 'host'])
    assert.equal(info.host, '192.168.1.5:8791')
  })

  test('carries no code once there is none outstanding', () => {
    assert.equal(pairing({ host: 'x', port: 1 }).code, null)
  })
})

describe('the addresses this machine answers on', () => {
  test('are all offered, with one of them first', async () => {
    const { addresses } = await import('../server/addresses.mjs')
    const found = addresses()
    assert.ok(found.all.includes(found.primary) || found.primary === 'localhost')
    assert.equal(new Set(found.all).size, found.all.length, 'no address offered twice')
    for (const a of found.all) {
      assert.match(a, /^\d{1,3}(\.\d{1,3}){3}$/)
      assert.ok(!a.startsWith('127.'), 'loopback is not something the iPad can reach')
      assert.ok(!a.startsWith('169.254'), 'a self-assigned address means the network did not work')
    }
  })
})

describe('what a person is told', () => {
  test('a checkout is told to use its npm script, an install its own command', async () => {
    const { setupCommand, pairingBanner } = await import('../server/pairing.mjs')
    assert.equal(setupCommand({ linked: false }), 'npm run setup')
    assert.equal(setupCommand({ linked: true }), 'sketchpad install')
    // Telling someone to run `sketchpad` when they cloned the repo is telling them to run
    // something they do not have on their PATH.
    const cloned = pairingBanner({ host: 'x', port: 1, code: 'AAAA-BBBB', linked: false }).join('\n')
    assert.ok(cloned.includes('npm run setup'))
    assert.ok(!cloned.includes('sketchpad install'))
  })

  test('the same wording serves the terminal and the agent', async () => {
    const { pairingBanner } = await import('../server/pairing.mjs')
    const lines = pairingBanner({ host: '192.168.1.5', port: 8791, code: 'AAAA-BBBB' })
    assert.ok(lines.some(l => l.includes('AAAA-BBBB')))
    assert.ok(lines.some(l => l.includes('192.168.1.5:8791')))
    assert.ok(lines.some(l => l.includes('ten minutes')))
  })

  test('with nothing to show, it says the server is open rather than staying quiet', async () => {
    const { pairingBanner } = await import('../server/pairing.mjs')
    assert.ok(pairingBanner({ host: 'x', port: 1 }).join('\n').includes('OPEN'))
  })
})
