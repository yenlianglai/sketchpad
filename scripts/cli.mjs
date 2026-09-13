#!/usr/bin/env node
// The command people actually type.
//
//   sketchpad install     register every MCP client on this machine, and start at login
//   sketchpad uninstall   undo both
//   sketchpad status      is it running, is it registered, is it set to start at login
//   sketchpad pair        print the QR again
//   sketchpad start       run it in the foreground
//
// Nothing here needs a terminal after the first run — that is the point of `install`.

import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { autostartPlan } from './autostart.mjs'
import { configHome } from '../server/paths.mjs'
import { loadOrCreateToken } from '../server/auth.mjs'
import { localFetch, localURL } from '../server/local-fetch.mjs'
import { pairingBanner } from '../server/pairing.mjs'
import { spoolDir, serverLogPath } from '../server/paths.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'server', 'index.mjs')
const REGISTER = join(ROOT, 'scripts', 'register.mjs')
const PORT = Number(process.env.SKETCHPAD_PORT ?? 8791)

// `sketchpad status | head -2` closes the pipe early; without this that surfaces as an unhandled
// EPIPE and a stack trace, which reads as the tool being broken rather than the pipe ending.
process.stdout.on('error', err => { if (err.code === 'EPIPE') process.exit(0); throw err })

const say = (...a) => console.log(...a)
const plan = () => autostartPlan({ entry: ENTRY, home: homedir(), configHome: configHome() })

const run = ({ file, args }) => {
  try {
    execFileSync(file, args, { stdio: 'pipe' })
    return true
  } catch (err) {
    // launchctl and systemctl both fail loudly when the job is already loaded, which is not an error
    // worth stopping an install over.
    const message = (err.stderr?.toString() || err.message || '').trim()
    if (/already (loaded|enabled|bootstrapped)|File exists/i.test(message)) return true
    say(`   (${file} said: ${message.split('\n')[0]})`)
    return false
  }
}

/// Anything the running server can answer. Null when nothing is there; `{ refused }` when something
/// is, but will not have us — an older server still holding the port, typically, with a token that
/// no longer matches the one on disk. Reporting that as "not running" sends you looking in the
/// wrong place entirely.
const ask = async (path, init = {}) => {
  const { token } = loadOrCreateToken()
  try {
    const res = await localFetch()(`${localURL()}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(1500)
    })
    if (res.ok) return res.json()
    return res.status === 401 ? { refused: true } : null
  } catch { return null }
}
const running = () => ask('/health')

async function install() {
  say('Registering MCP clients…')
  spawn(process.execPath, [REGISTER, '--write'], { stdio: 'inherit' }).on('exit', async () => {
    const p = plan()
    say(`\nStarting at login (${p.kind})…`)
    mkdirSync(dirname(p.path), { recursive: true })
    writeFileSync(p.path, p.contents)
    say(`   ${p.path}`)
    const ok = p.enable.every(run)
    say(ok ? '   enabled' : '   written, but the system did not take it — see above')

    // Some mechanisms start it as a side effect of being enabled and some only act at next login.
    // Either way you asked for it now, so make sure it is actually up.
    const up = await startIfNeeded()
    say(up ? '   running' : '   could not start it — try `sketchpad start` to see why')

    say('\nDone. Open Sketchpad on your iPad, then `sketchpad pair` for a code to type in.')
  })
}

/// Start the server detached if nothing is answering yet. Returns whether it came up.
async function startIfNeeded() {
  if (await running()) return true
  mkdirSync(spoolDir(), { recursive: true })
  const out = openSync(serverLogPath(), 'a')
  spawn(process.execPath, [ENTRY], { detached: true, stdio: ['ignore', out, out] }).unref()
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 400))
    if (await running()) return true
  }
  return false
}

function uninstall() {
  const p = plan()
  p.disable.forEach(run)
  if (existsSync(p.path)) { rmSync(p.path); say(`removed ${p.path}`) }
  else say('was not set to start at login')
  say('MCP client configs were left alone — remove the "sketchpad" entry by hand if you want it gone.')
}

/// Whether it will really start at login. The file existing is not the same as the system having
/// been told about it — it can be written and never loaded, or booted out and left behind.
function describeAutostart(plan) {
  if (!existsSync(plan.path)) return 'no'
  if (!plan.check) return `yes (${plan.path})`
  try {
    execFileSync(plan.check.file, plan.check.args, { stdio: 'pipe' })
    return `yes (${plan.path})`
  } catch {
    return `installed but not loaded — run \`sketchpad install\` again  (${plan.path})`
  }
}

async function status() {
  const p = plan()
  const health = await running()
  if (health?.refused) {
    say(`server        something is on ${PORT} but will not accept this machine's token`)
    say(`              probably an older sketchpad still running — find it with:`)
    say(`                lsof -nP -iTCP:${PORT} -sTCP:LISTEN`)
  } else {
    say(`server        ${health ? `running on ${PORT}` : 'not running'}`)
  }
  if (health && !health.refused) say(`iPad          ${health.clients > 0 ? `${health.clients} connected` : 'not connected'}`)
  say(`at login      ${describeAutostart(p)}`)
  say(`token         ${loadOrCreateToken().source}`)
  const paired = await ask('/devices')
  if (Array.isArray(paired)) say(`paired        ${paired.length ? paired.map(d => d.name).join(', ') : 'nothing yet'}`)

  const pending = await ask('/pair')
  if (pending?.code) {
    const left = Math.round((pending.expiresAt - Date.now()) / 60000)
    say(`pairing code  ${pending.code} — ${left < 1 ? 'under a minute' : `${left} min`} left`)
  }
}

/// A fresh code every time: asking for a code is asking to add one more device, and the previous
/// one should stop working the moment a new one is on screen.
async function pair() {
  const info = await ask('/pair?new=1')
  if (!info) {
    say(`no sketchpad running on ${PORT} — start it with \`sketchpad start\`, or \`sketchpad install\` to keep it running.`)
    process.exitCode = 1
    return
  }
  // Same wording the server prints on startup — one place, so it cannot drift.
  const [host, port] = info.host.split(':')
  say(pairingBanner({
    host, port: Number(port), code: info.code,
    alt: info.alt.map(a => a.split(':')[0])
  }).join('\n'))
}

async function devices() {
  const list = await ask('/devices')
  if (!list) { say('no sketchpad running'); process.exitCode = 1; return }
  if (!list.length) { say('no iPads paired yet — run `sketchpad pair`'); return }
  for (const d of list) {
    say(`${d.id}  ${d.name.padEnd(24)} paired ${new Date(d.pairedAt).toLocaleDateString()}  last seen ${new Date(d.lastSeen).toLocaleString()}`)
  }
}

async function revoke() {
  const id = process.argv[3]
  if (!id) { say('which one? `sketchpad devices` lists them.'); process.exitCode = 1; return }
  const done = await ask(`/devices?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  say(done ? `revoked ${id} — that iPad will need a new pairing code` : `no device ${id}`)
  if (!done) process.exitCode = 1
}

const forward = extraEnv =>
  spawn(process.execPath, [ENTRY], { stdio: 'inherit', env: { ...process.env, ...extraEnv } })
    .on('exit', code => process.exit(code ?? 0))

const command = process.argv[2] ?? 'help'
const commands = {
  install,
  uninstall,
  status,
  start: () => forward({}),
  pair,
  devices,
  revoke,
  help: () => say(`sketchpad install       register MCP clients and start at login
sketchpad uninstall     undo both
sketchpad status        what is running, registered and enabled
sketchpad pair          show a QR that pairs one more iPad
sketchpad devices       the iPads that can connect
sketchpad revoke <id>   take one iPad's access away
sketchpad start         run the server in the foreground`)
}

if (!commands[command]) {
  console.error(`unknown command: ${command}\n`)
  commands.help()
  process.exit(1)
}
await commands[command]()
