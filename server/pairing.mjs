// Getting an iPad connected without typing anything: Bonjour so the app finds this computer on its
// own, and a QR in the terminal for networks that block it.

import { networkInterfaces, hostname } from 'node:os'
import qrcode from 'qrcode-terminal'
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

/// What the QR encodes. A `code` is exchanged for a key of the device's own; a `token` is that key
/// directly, which is what a server running without pairing (SKETCHPAD_NO_TOKEN) has to fall back on.
/// What the QR encodes. A `code` is exchanged for a key of the device's own; a `token` is that key
/// directly, which is what a server running without pairing has to fall back on. `fp` is the
/// certificate fingerprint the iPad pins — the reason a self-signed certificate is safe here is that
/// this arrives by a channel nobody on the network can touch.
export function pairingURL({ host, port, token, code, scheme = 'http', fingerprint, alt = [] }) {
  const parts = [`host=${host}:${port}`]
  // Other addresses the same machine answers on — a tailnet address, typically, so one scan works
  // both at home and away. The app tries them in order.
  const others = alt.filter(h => h && h !== host).map(h => `${h}:${port}`)
  if (others.length) parts.push(`alt=${encodeURIComponent(others.join(','))}`)
  if (code) parts.push(`code=${encodeURIComponent(code)}`)
  else if (token) parts.push(`token=${encodeURIComponent(token)}`)
  if (scheme !== 'http') parts.push(`scheme=${scheme}`)
  if (fingerprint) parts.push(`fp=${fingerprint}`)
  return {
    host: `${host}:${port}`, token: token || null, code: code || null,
    alt: others, scheme, fingerprint: fingerprint || null,
    url: `sketchpad://pair?${parts.join('&')}`
  }
}

/// Printed to stderr, never stdout: in stdio mode stdout is the MCP transport.
export function printPairing({ host, port, token, code, scheme, fingerprint, alt = [] }) {
  const { url } = pairingURL({ host, port, token, code, scheme, fingerprint, alt })
  const out = s => process.stderr.write(s + '\n')
  out('')
  out('  iPad    open Sketchpad — it finds this computer on the network. Or scan:')
  out('')
  qrcode.generate(url, { small: true }, q => out(q.split('\n').map(l => '  ' + l).join('\n')))
  out(`  ${url}`)
  out('')
  out('  Agent   sketchpad install')
  out('')
  if (alt.some(h => h && /^100\./.test(h))) {
    out('  Tailnet this code also works away from this network, over Tailscale.')
    out('')
  }
  // The QR carries the token, so the only thing worth saying is whether there is one.
  out(code
    ? `  Locked  this code pairs one iPad, once, within ten minutes.${fingerprint ? ' Encrypted.' : ''}`
    : token
      ? '  Locked  only devices holding this key can connect.'
      : '  OPEN    no token: anyone on this network can read your canvas and this machine\'s files.')
  out('')
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
