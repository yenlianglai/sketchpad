// Getting an iPad connected without typing anything: Bonjour so the app finds this computer on its
// own, and a QR in the terminal for networks that block it.

import { networkInterfaces, hostname } from 'node:os'
import { Bonjour } from 'bonjour-service'

/// Tailscale hands out addresses from the carrier-grade NAT range, which nothing else on a home
/// network uses. Spotting one needs no CLI and no dependency.
const isTailnet = ip => {
  const [a, b] = ip.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}
const usable = a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')

/// Every address this machine can be reached on, best first: the local network, then the tailnet.
///
/// Both go in the pairing QR. On your own wifi the local address is direct and fast; away from it
/// the tailnet address still works, over WireGuard, with no relay of ours in between. One scan
/// covers being at home and being somewhere else.
export function addresses() {
  const all = Object.values(networkInterfaces()).flatMap(list => list ?? []).filter(usable)
  const lan = all.filter(a => !isTailnet(a.address)).map(a => a.address)
  const tailnet = all.filter(a => isTailnet(a.address)).map(a => a.address)
  return { lan: lan[0] ?? 'localhost', tailnet: tailnet[0] ?? null, all: [...lan, ...tailnet] }
}

/// The address an iPad on the same network should use.
export const lanIP = () => addresses().lan

/// What the iPad needs to be told, and what it works out for itself.
///
/// Only the code is here. The address it usually finds over Bonjour, and the certificate it learns
/// during pairing — the proof it sends is bound to whatever certificate it was shown, so a wrong one
/// is rejected by the server rather than having to be checked up front.
export function pairing({ host, port, code, expiresAt, alt = [] }) {
  return {
    host: `${host}:${port}`,
    alt: alt.filter(h => h && h !== host).map(h => `${h}:${port}`),
    code: code || null,
    expiresAt: expiresAt || null
  }
}

/// Printed to stderr, never stdout: in stdio mode stdout is the MCP transport.
export function printPairing({ host, port, code, alt = [], token }) {
  const out = s => process.stderr.write(s + '\n')
  const { host: address, alt: others } = pairing({ host, port, alt })
  out('')
  if (code) {
    out('  iPad    open Sketchpad and type this code:')
    out('')
    out(`      ${code}`)
    out('')
    out('          good for ten minutes, and for one iPad')
  } else if (token) {
    out(`  iPad    open Sketchpad and enter this key:  ${token}`)
  } else {
    out('  OPEN    no token: anyone on this network can read your canvas and this machine\'s files.')
  }
  out('')
  out(`  Mac     ${address}${others.length ? `  ·  also ${others.join('  ')}` : ''}`)
  out('          Sketchpad finds this on its own if your network allows it')
  out('')
  out('  Agent   sketchpad install')
  out('')
  if (alt.some(h => h && /^100\./.test(h))) {
    out('  Tailnet this code also works away from this network, over Tailscale.')
    out('')
  }
}

/// Advertise `_sketchpad._tcp` so the app finds this computer without anyone typing an address.
/// Pure JS rather than macOS's `dns-sd`, so this works on Windows and Linux too. Returns a stop
/// function; a network that blocks multicast just means the app falls back to the QR.
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
  // and discovery is a convenience: the QR still works.
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
