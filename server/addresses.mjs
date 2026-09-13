// Where this machine can be reached, and telling the network it is here.

import { networkInterfaces, hostname } from 'node:os'
import { Bonjour } from 'bonjour-service'

const usable = a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')

/// Every address this machine can be reached on, the first one first.
///
/// A laptop usually has more than one — wifi and ethernet, or a VPN alongside either. The iPad is
/// told all of them and tries each in turn, so moving between them does not need a re-pair, and the
/// certificate is issued for all of them so none of them fails the name check.
export function addresses() {
  const all = Object.values(networkInterfaces()).flatMap(list => list ?? []).filter(usable).map(a => a.address)
  return { primary: all[0] ?? 'localhost', all }
}

/// Advertise `_sketchpad._tcp` so the app finds this computer without anyone typing an address.
/// Pure JS rather than macOS's `dns-sd`, so this works on Windows and Linux too. Returns a stop
/// function; a network that blocks multicast just means the address has to be typed.
export function advertiseBonjour({ port, log = () => {} }) {
  if (process.env.SKETCHPAD_NO_BONJOUR) return () => {}
  const name = process.env.SKETCHPAD_NAME || `Sketchpad on ${hostname().replace(/\.local$/, '')}`

  let bonjour, service
  try {
    bonjour = new Bonjour()
    // probe: false because the library throws — rather than emits — when it finds the name taken,
    // which would take the whole server down over a discovery convenience. Two servers advertising
    // the same name just means the app offers you both.
    service = bonjour.publish({ name, type: 'sketchpad', protocol: 'tcp', port, probe: false, txt: { path: '/' } })
  } catch (err) {
    log('bonjour unavailable:', err.message)
    return () => {}
  }
  // Publishing probes the network asynchronously, so a clash or a blocked multicast arrives as an
  // event long after this function returns. Unhandled, it would take the server down with it —
  // and discovery is a convenience, not the only way in.
  service?.on?.('error', err => log('bonjour unavailable:', err.message))

  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try { bonjour.unpublishAll(() => bonjour.destroy()) } catch { /* going away anyway */ }
  }
  process.on('exit', stop)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(0) })
  return stop
}
