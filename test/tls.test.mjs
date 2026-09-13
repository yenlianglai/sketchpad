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
import { pairingURL } from '../server/pairing.mjs'

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

  test('is what the QR carries, and it matches the certificate being served', async () => {
    const { cert, fingerprint: fp } = await loadOrCreateCert({ dir, hosts: ['192.168.1.5'] })
    const { url } = pairingURL({ host: '192.168.1.5', port: 8791, code: 'abc', scheme: 'https', fingerprint: fp })
    const carried = new URL(url.replace('sketchpad://', 'https://')).searchParams.get('fp')
    assert.equal(carried, fingerprint(cert))
  })

  test('is left out when there is no TLS, so the app knows to use plain http', () => {
    const { url, scheme } = pairingURL({ host: '192.168.1.5', port: 8791, code: 'abc' })
    assert.equal(scheme, 'http')
    assert.ok(!url.includes('fp='), url)
    assert.ok(!url.includes('scheme='), url)
  })

  test('a pairing code is still preferred over a raw key when both could be sent', () => {
    const { url } = pairingURL({ host: 'x:1', port: 8791, token: 'key', code: 'code', scheme: 'https', fingerprint: 'ab' })
    assert.ok(url.includes('code=code'))
    assert.ok(!url.includes('token='), 'the long-lived key should never be printed when a code will do')
  })
})
