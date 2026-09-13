#!/usr/bin/env node
// One command to register Sketchpad with every MCP client on this machine — no paths to type.
// A shipping product would do this from its installer; this is the same logic, run by hand.
//
//   npm run register            see what would change
//   npm run register -- --write apply it
//
// Each client's config is merged, never replaced, and backed up next to itself first.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpClients, whichCommand } from './clients.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'server', 'mcp-stdio.mjs')
const WRITE = process.argv.includes('--write')
const NAME = 'sketchpad'

// Prefer the globally linked name when it resolves, so configs stay portable.
function command() {
  try {
    const { file, args } = whichCommand('sketchpad-mcp')
    const p = execFileSync(file, args, { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    if (p) return { command: p, args: [] }
  } catch {}
  return { command: process.execPath, args: [ENTRY] }
}
const CMD = command()

const clients = mcpClients()

const say = (...a) => console.log(...a)
let changed = 0, skipped = 0

for (const c of clients) {
  if (c.kind === 'cli') {
    let has = false, cli = true
    try { has = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' }).includes(`${NAME}:`) }
    catch { cli = false }
    if (!cli) { say(`·  ${c.label}: not installed`); skipped++; continue }
    const argv = ['mcp', 'add', '--scope', 'user', NAME, '--', CMD.command, ...CMD.args]
    if (!WRITE) { say(`→  ${c.label}: ${has ? 'replace existing' : 'add'}  (claude ${argv.join(' ')})`); changed++; continue }
    try {
      if (has) execFileSync('claude', ['mcp', 'remove', '--scope', 'user', NAME], { stdio: 'ignore' })
      execFileSync('claude', argv, { stdio: 'ignore' })
      say(`✓  ${c.label}: registered`)
      changed++
    } catch (err) { say(`✗  ${c.label}: ${err.message.split('\n')[0]}`) }
    continue
  }

  // JSON-config clients: only touch one that is actually installed.
  const dir = dirname(c.path)
  if (!existsSync(dir)) { say(`·  ${c.label}: not installed`); skipped++; continue }
  let cfg = {}
  if (existsSync(c.path)) {
    try { cfg = JSON.parse(readFileSync(c.path, 'utf8')) }
    catch { say(`✗  ${c.label}: ${c.path} is not valid JSON, leaving it alone`); continue }
  }
  const bucket = cfg[c.key] ?? {}
  const entry = { command: CMD.command, ...(CMD.args.length ? { args: CMD.args } : {}) }
  if (JSON.stringify(bucket[NAME]) === JSON.stringify(entry)) { say(`·  ${c.label}: already registered`); skipped++; continue }
  if (!WRITE) { say(`→  ${c.label}: ${bucket[NAME] ? 'update' : 'add'} in ${c.path}`); changed++; continue }
  if (existsSync(c.path)) copyFileSync(c.path, c.path + '.bak')
  else mkdirSync(dir, { recursive: true })
  cfg[c.key] = { ...bucket, [NAME]: entry }
  writeFileSync(c.path, JSON.stringify(cfg, null, 2) + '\n')
  say(`✓  ${c.label}: registered in ${c.path}`)
  changed++
}

say('')
say(`command: ${CMD.command}${CMD.args.length ? ' ' + CMD.args.join(' ') : ''}`)
if (!WRITE) say(`${changed} to change, ${skipped} skipped — run \`npm run register -- --write\` to apply`)
else say(`${changed} registered, ${skipped} skipped. Restart the app for a GUI client to pick it up.`)
