// The iPads allowed to connect, and how one gets added.
//
// Printing the long-lived token straight into the QR meant that anyone who ever saw that terminal —
// a screenshot, a photo, someone walking past — held the key for good, with no way to take it back
// short of changing it for every device at once.
//
// So the QR carries a pairing code instead: short-lived, good for one device, and spent the moment
// it is used. The device exchanges it for a key of its own. Losing an iPad now costs you one line
// in a file rather than a re-pair of everything you own.

import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sameSecret } from './auth.mjs'

/// Long enough that a code cannot be guessed before it expires, short enough to survive a photo of
/// a terminal at an angle.
export const CODE_TTL_MS = 10 * 60 * 1000

export function createDevices({ dir, now = () => Date.now() }) {
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

  /// A fresh code, replacing any unspent one — showing a new QR should retire the old.
  function mintCode() {
    pending = { code: randomBytes(9).toString('base64url'), expiresAt: now() + CODE_TTL_MS }
    return { ...pending }
  }

  /// Exchange a code for this device's own key. Null if the code is wrong, spent or expired.
  function redeem(code, name = 'iPad') {
    if (!pending || now() > pending.expiresAt) return null
    if (!code || !sameSecret(code, pending.code)) return null
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
    pendingCode: () => (pending && now() <= pending.expiresAt ? pending.code : null)
  }
}
