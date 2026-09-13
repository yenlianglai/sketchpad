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
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import qrcode from 'qrcode-terminal'
import { autostartPlan } from './autostart.mjs'
import { configHome } from '../server/paths.mjs'
import { loadOrCreateToken } from '../server/auth.mjs'
import { localFetch, localURL } from '../server/local-fetch.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'server', 'index.mjs')
const REGISTER = join(ROOT, 'scripts', 'register.mjs')
const PORT = Number(process.env.SKETCHPAD_PORT ?? 8791)

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

/// Anything the running server can answer. Null when it is not running.
const ask = async (path, init = {}) => {
  const { token } = loadOrCreateToken()
  try {
    const res = await localFetch()(`${localURL()}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(1500)
    })
    return res.ok ? await res.json() : null
  } catch { return null }
}
const running = () => ask('/health')

async function install() {
  say('Registering MCP clients…')
  spawn(process.execPath, [REGISTER, '--write'], { stdio: 'inherit' }).on('exit', () => {
    const p = plan()
    say(`\nStarting at login (${p.kind})…`)
    mkdirSync(dirname(p.path), { recursive: true })
    writeFileSync(p.path, p.contents)
    say(`   ${p.path}`)
    const ok = p.enable.every(run)
    say(ok ? '   enabled' : '   written, but the system did not take it — see above')
    say('\nDone. Open Sketchpad on your iPad; it will find this computer.')
    say('Run `sketchpad pair` if you need the QR code.')
  })
}

function uninstall() {
  const p = plan()
  p.disable.forEach(run)
  if (existsSync(p.path)) { rmSync(p.path); say(`removed ${p.path}`) }
  else say('was not set to start at login')
  say('MCP client configs were left alone — remove the "sketchpad" entry by hand if you want it gone.')
}

async function status() {
  const p = plan()
  const health = await running()
  say(`server        ${health ? `running on ${PORT}` : 'not running'}`)
  if (health) say(`iPad          ${health.clients > 0 ? `${health.clients} connected` : 'not connected'}`)
  say(`at login      ${existsSync(p.path) ? `yes (${p.path})` : 'no'}`)
  say(`token         ${loadOrCreateToken().source}`)
  const paired = await ask('/devices')
  if (paired) say(`paired        ${paired.length ? paired.map(d => d.name).join(', ') : 'nothing yet'}`)
}

/// A fresh code every time: showing a QR is asking for one more device, and the old code should
/// stop working the moment a new one is on screen.
async function pair() {
  const info = await ask('/pair?new=1')
  if (!info) {
    say(`no sketchpad running on ${PORT} — start it with \`sketchpad start\`, or \`sketchpad install\` to keep it running.`)
    process.exitCode = 1
    return
  }
  say('')
  qrcode.generate(info.url, { small: true }, q => say(q.split('\n').map(l => '  ' + l).join('\n')))
  say(`  ${info.url}`)
  say(info.code ? '\n  Pairs one iPad, once, within ten minutes.' : '')
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
