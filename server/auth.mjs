// Who is allowed to talk to this server.
//
// The default has to be the safe one. A server that binds the whole network and checks nothing is
// an open door: anyone on the same wifi could mirror everything you draw, screenshot your iPad on
// demand, and read files off this machine. So a token is generated on first run and kept, rather
// than being something you remember to switch on.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './paths.mjs'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/// The token for this machine: the one in the environment, else the one on disk, else a new one.
/// Written owner-only, because anyone who can read it can read your canvas.
export function loadOrCreateToken({ dir = configDir(), env = process.env } = {}) {
  if (env.SKETCHPAD_TOKEN) return { token: env.SKETCHPAD_TOKEN, source: 'environment' }
  if (env.SKETCHPAD_NO_TOKEN === '1') return { token: '', source: 'disabled' }

  const path = join(dir, 'token')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing) return { token: existing, source: 'saved' }
  } catch { /* first run, or someone removed it: make a new one below */ }

  const token = randomBytes(24).toString('base64url')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, token + '\n', { mode: 0o600 })
  return { token, source: 'new' }
}

/// The token a request carries: a bearer header by preference, or the query string, which is what
/// a WebSocket URL out of a QR code can manage.
export function presentedToken(req, url) {
  const header = req?.headers?.authorization ?? ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return url.searchParams.get('token') ?? ''
}

export const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export const isLoopback = req => LOOPBACK.has(req?.socket?.remoteAddress ?? '')

/// Decides every request. `/mcp` is held to a stricter rule than the iPad's routes: the agent runs
/// on this machine, so there is no reason for the tools to be reachable from the network at all.
export function makeAuthorizer({ token, allowRemoteMCP = false }) {
  return function authorize(req, url) {
    if (url.pathname === '/mcp' && !allowRemoteMCP && !isLoopback(req)) return false
    if (!token) return true
    return sameSecret(presentedToken(req, url), token)
  }
}
