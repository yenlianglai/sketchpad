#!/usr/bin/env node
// Entry point used when Sketchpad is installed as a plugin: a plugin install is a git clone, so
// node_modules may not exist yet. Install once, then hand over to the real stdio wrapper.
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(ROOT, 'node_modules', '@modelcontextprotocol'))) {
  console.error('[sketchpad-mcp] first run: installing dependencies…')
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
  } catch (err) {
    console.error('[sketchpad-mcp] npm install failed:', err.message)
    process.exit(1)
  }
}
await import('./mcp-stdio.mjs')
