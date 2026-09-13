// Getting an iPad connected without typing anything: Bonjour so the app finds this computer on its
// own, and a QR in the terminal for networks that block it.

import { networkInterfaces, hostname } from 'node:os'
import qrcode from 'qrcode-terminal'
import { Bonjour } from 'bonjour-service'

/// The address an iPad on the same network should use. Skips loopback and self-assigned addresses.
export function lanIP() {
  for (const addresses of Object.values(networkInterfaces()))
    for (const a of addresses ?? [])
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) return a.address
  return 'localhost'
}

export function pairingURL({ host, port, token }) {
  const url = `sketchpad://pair?host=${host}:${port}` + (token ? `&token=${encodeURIComponent(token)}` : '')
  return { host: `${host}:${port}`, token: token || null, url }
}

/// Printed to stderr, never stdout: in stdio mode stdout is the MCP transport.
export function printPairing({ host, port, token, tokenSource }) {
  const { url } = pairingURL({ host, port, token })
  const out = s => process.stderr.write(s + '\n')
  out('')
  out('  iPad    open Sketchpad — it finds this computer on the network. Or scan:')
  out('')
  qrcode.generate(url, { small: true }, q => out(q.split('\n').map(l => '  ' + l).join('\n')))
  out(`  ${url}`)
  out('')
  out('  Agent   sketchpad install')
  out('')
  // The QR carries the token, so the only thing worth saying is whether there is one.
  out(token
    ? '  Locked  only devices that scan this code can connect.'
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
