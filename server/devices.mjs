// The iPads allowed to connect, and how one gets added.
//
// Pairing is eight characters you read off the screen and type into the iPad. Short-lived, good for
// one device, spent the moment it is used — so a screenshot taken afterwards is worth nothing, and
// losing an iPad costs one line in a file rather than a re-pair of everything you own.
//
// The code itself never crosses the network. The iPad sends a proof derived from the code *and the
// certificate it was just shown*, and the server checks it against its own certificate. Someone
// sitting in the middle presents a certificate of their own, so their proof does not match and the
// server turns them away — and the proof does not give them the code either. That binding is what
// lets eight typed characters be as safe as a fingerprint scanned off the screen.
//
// The derivation is deliberately slow. Without that, a proof captured in the middle would give up a
// forty-bit code to an offline search in seconds.

import { randomBytes, randomUUID, pbkdf2Sync } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sameSecret } from './auth.mjs'

/// Long enough to type without irritation, short enough that nobody minds reading it out.
export const CODE_TTL_MS = 10 * 60 * 1000
const CODE_LENGTH = 8
/// No I, L, O or U: nothing that can be misread as a digit, or misheard when read aloud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ITERATIONS = 200_000

/// What the iPad actually sends. Typed by a person, so case and the grouping dash do not matter.
export const proofFor = (code, fingerprint = '') =>
  pbkdf2Sync(normalizeCode(code), `sketchpad-pairing-v1:${fingerprint}`, ITERATIONS, 32, 'sha256')
    .toString('base64url')

export const normalizeCode = code =>
  String(code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')

/// Shown as XXXX-XXXX. Easier to read back to someone, and easier to keep your place typing it.
export const formatCode = code =>
  normalizeCode(code).replace(/^(.{4})(.{4})$/, '$1-$2')

/// `fingerprint` is this server's certificate — what a pairing proof is bound to. Empty when TLS is
/// off, which leaves the code hidden but with nothing to bind it to.
export function createDevices({ dir, now = () => Date.now(), fingerprint = () => '' }) {
  const path = join(dir, 'devices.json')
  let devices = read()
  let pending = null      // the one unspent pairing code, if there is one

  function read() {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []   // no devices yet, or a file someone edited badly: pairing still works
    }
  }
  function save() {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(devices, null, 1), { mode: 0o600 })
  }

  /// A fresh code, replacing any unspent one — showing a new code should retire the old.
  function mintCode() {
    const bytes = randomBytes(CODE_LENGTH)
    const code = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('')
    pending = { code, expiresAt: now() + CODE_TTL_MS }
    return { code, formatted: formatCode(code), expiresAt: pending.expiresAt }
  }

  /// Exchange a proof of the code for this device's own key. Null if it is wrong, spent or expired.
  ///
  /// Takes the proof rather than the code so that neither the network nor anyone standing in the
  /// middle of it ever sees what was typed.
  function redeem(proof, name = 'iPad') {
    if (!pending || now() > pending.expiresAt) return null
    if (!proof || !sameSecret(proof, proofFor(pending.code, fingerprint()))) return null
    pending = null   // one device per code

    const device = {
      id: randomUUID().slice(0, 8),
      name: String(name).slice(0, 60),
      token: randomBytes(24).toString('base64url'),
      pairedAt: now(),
      lastSeen: now()
    }
    devices.push(device)
    save()
    return { id: device.id, token: device.token, name: device.name }
  }

  /// Is this one of our devices? Records the sighting, so the list can say when each was last used.
  function accepts(token) {
    if (!token) return false
    const device = devices.find(d => sameSecret(d.token, token))
    if (!device) return false
    // Only write when the day has moved on: this runs on every request.
    if (now() - device.lastSeen > 60_000) { device.lastSeen = now(); save() }
    return true
  }

  function revoke(id) {
    const before = devices.length
    devices = devices.filter(d => d.id !== id)
    if (devices.length === before) return false
    save()
    return true
  }

  return {
    mintCode,
    redeem,
    accepts,
    revoke,
    /// Never includes the keys themselves.
    list: () => devices.map(({ token, ...rest }) => rest),
    /// The code as it should be shown to a person, or null once it is spent or expired.
    pendingCode: () => (pending && now() <= pending.expiresAt ? formatCode(pending.code) : null),
    expiresAt: () => (pending && now() <= pending.expiresAt ? pending.expiresAt : null)
  }
}
