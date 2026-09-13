// Encryption on a network with no certificate authority.
//
// Everything used to cross the wifi in the clear: your pages, your handwriting, the agent's replies.
// A token stops someone joining in, but not someone listening.
//
// There is nobody to issue a certificate for a laptop on a home network, so the server signs its
// own — and the QR, which you scan off your own screen, carries its fingerprint. The iPad pins that
// fingerprint at pairing and refuses anything else afterwards. Trust comes from the code you
// scanned, not from a certificate chain, which is the honest shape for a machine on your desk.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import selfsigned from 'selfsigned'

const CERT_DAYS = 3650

/// sha256 of the certificate, lowercase hex, no colons — what goes in the QR and what the iPad pins.
export const fingerprint = cert =>
  new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase()

/// The certificate for this machine: the one on disk, or a new one covering the addresses it
/// answers on. Regenerated when the machine's address changes, since a pinned certificate is
/// checked by fingerprint but still has to be valid for the name being dialled.
export async function loadOrCreateCert({ dir, hosts = [] }) {
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')

  try {
    const cert = readFileSync(certPath, 'utf8')
    const key = readFileSync(keyPath, 'utf8')
    const x509 = new X509Certificate(cert)
    const stillValid = new Date(x509.validTo) > new Date()
    const covers = hosts.every(h => coveredBy(x509, h))
    if (stillValid && covers) return { cert, key, fingerprint: fingerprint(cert), source: 'saved' }
  } catch { /* no certificate yet, or one we cannot read: make a new one */ }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: 'sketchpad.local' },
    { type: 7, ip: '127.0.0.1' },
    ...hosts.map(h => (isIP(h) ? { type: 7, ip: h } : { type: 2, value: h }))
  ]
  // selfsigned 2.x, not 3+: the newer line ignores `days` and issues a one-year certificate. A
  // certificate that expires is a certificate that gets regenerated, and a new fingerprint locks
  // out every iPad that pinned the old one.
  const pems = selfsigned.generate([{ name: 'commonName', value: 'sketchpad' }], {
    days: CERT_DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: dedupe(altNames) }]
  })

  mkdirSync(dir, { recursive: true })
  writeFileSync(certPath, pems.cert, { mode: 0o600 })
  writeFileSync(keyPath, pems.private, { mode: 0o600 })
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprint(pems.cert), source: 'new' }
}

const isIP = h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h)

function coveredBy(x509, host) {
  const san = x509.subjectAltName ?? ''
  return san.includes(isIP(host) ? `IP Address:${host}` : `DNS:${host}`)
}

const dedupe = names => {
  const seen = new Set()
  return names.filter(n => {
    const key = `${n.type}:${n.ip ?? n.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
