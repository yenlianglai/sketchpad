// The things that are different on each platform. None of these can be checked by running the
// tests, because the tests only ever run on one platform at a time — so they are checked by
// construction instead, against a stand-in home directory.
//
// The failure being guarded against is silent: a wrong config path makes register.mjs report
// "not installed" and carry on, and a wrong cache path drops a stray ~/Library into a Linux home.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mcpClients, whichCommand } from '../scripts/clients.mjs'

const byId = list => Object.fromEntries(list.map(c => [c.id, c]))

describe('MCP client config locations', () => {
  const mac = byId(mcpClients({ config: '/Users/x/Library/Application Support', home: '/Users/x' }))
  const win = byId(mcpClients({ config: 'C:\\Users\\x\\AppData\\Roaming', home: 'C:\\Users\\x' }))
  const linux = byId(mcpClients({ config: '/home/x/.config', home: '/home/x' }))

  test('follow the platform config directory where the client does', () => {
    assert.match(mac['claude-desktop'].path, /Library\/Application Support\/Claude\/claude_desktop_config\.json$/)
    assert.ok(win['claude-desktop'].path.includes('AppData'), win['claude-desktop'].path)
    assert.match(linux['claude-desktop'].path, /\.config\/Claude\/claude_desktop_config\.json$/)
  })

  test('VS Code is under the same config directory, not hardcoded to a Mac path', () => {
    assert.match(mac.vscode.path, /Library\/Application Support\/Code\/User\/mcp\.json$/)
    assert.match(linux.vscode.path, /\.config\/Code\/User\/mcp\.json$/)
    assert.ok(win.vscode.path.includes('AppData'), win.vscode.path)
  })

  test('the dotfile clients sit in the home directory on every platform', () => {
    for (const set of [mac, win, linux]) {
      assert.ok(set.cursor.path.includes('.cursor'), set.cursor.path)
      assert.ok(set.windsurf.path.includes('.codeium'), set.windsurf.path)
    }
  })

  test('every client says how to write it, and Claude Code is the CLI one', () => {
    for (const c of mcpClients()) {
      assert.ok(c.id && c.label, JSON.stringify(c))
      if (c.kind === 'json') assert.ok(c.path && c.key, `${c.id} needs a path and a key`)
      else assert.equal(c.kind, 'cli', `${c.id} is neither json nor cli`)
    }
    assert.equal(byId(mcpClients())['claude-code'].kind, 'cli')
  })

  test('no two clients claim the same file', () => {
    const paths = mcpClients().filter(c => c.path).map(c => c.path)
    assert.equal(new Set(paths).size, paths.length)
  })
})

describe('looking a command up on the PATH', () => {
  test('uses the shell on unix and where on Windows', () => {
    assert.deepEqual(whichCommand('sketchpad-mcp', 'darwin'), { file: 'sh', args: ['-lc', 'command -v sketchpad-mcp'] })
    assert.deepEqual(whichCommand('sketchpad-mcp', 'linux'), { file: 'sh', args: ['-lc', 'command -v sketchpad-mcp'] })
    assert.deepEqual(whichCommand('sketchpad-mcp', 'win32'), { file: 'where', args: ['sketchpad-mcp'] })
  })
})

describe('discovery', () => {
  test('does not shell out, so it is not tied to a macOS-only binary', async () => {
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../server/addresses.mjs', import.meta.url), 'utf8'))
    assert.ok(!/from 'node:child_process'/.test(source), 'spawning means depending on what is installed')
    assert.ok(!/platform !== 'darwin'/.test(source), 'advertising should not be skipped off macOS')
  })

  test('advertises and stops cleanly', async () => {
    const { advertiseBonjour } = await import('../server/addresses.mjs')
    const stop = advertiseBonjour({ port: 8893 })
    assert.equal(typeof stop, 'function')
    stop()
    stop()   // stopping twice should not throw on the way out
  })

  test('can be switched off, which is how the tests and CI run', async () => {
    const { advertiseBonjour } = await import('../server/addresses.mjs')
    process.env.SKETCHPAD_NO_BONJOUR = '1'
    try {
      assert.equal(advertiseBonjour({ port: 8893 })(), undefined)
    } finally {
      delete process.env.SKETCHPAD_NO_BONJOUR
    }
  })
})

describe('spotting an existing Claude Code registration', () => {
  // `claude mcp list` prints one line per server. A plugin contributes
  // "plugin:sketchpad:sketchpad", which is a different registration from a user-scope "sketchpad" —
  // mistaking one for the other made register try to remove something that was not there, and the
  // failure took the whole registration down with it.
  const isUserScope = listing => listing.split('\n').some(line => line.startsWith('sketchpad:'))

  test('a plugin entry is not a user-scope entry', () => {
    assert.equal(isUserScope('plugin:sketchpad:sketchpad: node /x/plugin-entry.mjs - ✔ Connected'), false)
  })

  test('a user-scope entry is', () => {
    assert.equal(isUserScope('sketchpad: /usr/local/bin/sketchpad-mcp - ✔ Connected'), true)
  })

  test('both at once still counts as registered', () => {
    assert.equal(isUserScope('plugin:sketchpad:sketchpad: node /x\nsketchpad: /usr/local/bin/sketchpad-mcp'), true)
  })

  test('an unrelated server is not mistaken for ours', () => {
    assert.equal(isUserScope('sketchpad-helper: /x\nother: /y'), false)
  })
})
