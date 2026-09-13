// Getting an iPad connected without typing anything: Bonjour so the app finds this computer on its
// own, and a QR in the terminal for networks that block it.

import { spawn } from 'node:child_process'
import { networkInterfaces, hostname } from 'node:os'
import qrcode from 'qrcode-terminal'

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
export function printPairing({ host, port, token }) {
  const { url } = pairingURL({ host, port, token })
  const out = s => process.stderr.write(s + '\n')
  out('')
  out('  iPad    open Sketchpad — it finds this computer on the network. Or scan:')
  out('')
  qrcode.generate(url, { small: true }, q => out(q.split('\n').map(l => '  ' + l).join('\n')))
  out(`  ${url}`)
  out('')
  out('  Agent   npm run register -- --write')
  out('')
}

/// macOS ships dns-sd, which is all this needs. Elsewhere the app falls back to the QR or a typed
/// address. Returns a stop function.
export function advertiseBonjour({ port, log = () => {} }) {
  if (process.platform !== 'darwin' || process.env.SKETCHPAD_NO_BONJOUR) return () => {}
  const name = process.env.SKETCHPAD_NAME || `Sketchpad on ${hostname().replace(/\.local$/, '')}`
  const child = spawn('dns-sd', ['-R', name, '_sketchpad._tcp', '.', String(port), 'path=/'], { stdio: 'ignore' })
  child.on('error', err => log('bonjour unavailable:', err.message))
  const stop = () => { try { child.kill() } catch {} }
  process.on('exit', stop)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(0) })
  return stop
}
