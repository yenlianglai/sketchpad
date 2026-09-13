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
import { autostartPlan } from './autostart.mjs'
import { configHome } from '../server/paths.mjs'
import { loadOrCreateToken } from '../server/auth.mjs'

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

const running = async () => {
  const { token } = loadOrCreateToken()
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1200)
    })
    return res.ok ? await res.json() : null
  } catch { return null }
}

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
  pair: () => forward({ SKETCHPAD_PAIR_ONLY: '1' }),
  help: () => say(`sketchpad install     register MCP clients and start at login
sketchpad uninstall   undo both
sketchpad status      what is running, registered and enabled
sketchpad pair        print the pairing QR
sketchpad start       run the server in the foreground`)
}

if (!commands[command]) {
  console.error(`unknown command: ${command}\n`)
  commands.help()
  process.exit(1)
}
await commands[command]()
