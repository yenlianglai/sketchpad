// Starting at login, on three platforms, checked from whichever one you are on.
//
// Nothing here touches the real LaunchAgents, systemd or Startup folder: the plan is a value, so
// it can be inspected without installing anything.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { autostartPlan, LABEL } from '../scripts/autostart.mjs'

const ENTRY = '/opt/sketchpad/server/index.mjs'
const NODE = '/usr/local/bin/node'
const forPlatform = platform => autostartPlan({
  platform, node: NODE, entry: ENTRY,
  home: platform === 'win32' ? 'C:\\Users\\x' : '/home/x',
  configHome: platform === 'win32' ? 'C:\\Users\\x\\AppData\\Roaming' : '/home/x/.config'
})

describe('every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    describe(platform, () => {
      const plan = forPlatform(platform)

      test('runs the server with this node, by absolute path', () => {
        assert.ok(plan.contents.includes(ENTRY), 'the entry point must be absolute: login has no cwd')
        assert.ok(plan.contents.includes(NODE), 'must not rely on node being on the login PATH')
      })

      test('writes exactly one file, and says how to undo it', () => {
        assert.ok(plan.path.length > 0)
        assert.equal(plan.enable.length, plan.disable.length === 0 ? 0 : plan.enable.length)
        assert.ok(Array.isArray(plan.disable))
      })

      test('leaves no placeholder unfilled', () => {
        assert.ok(!/undefined|\[object|\$\{/.test(plan.contents), plan.contents)
      })
    })
  }
})

describe('macOS', () => {
  const plan = forPlatform('darwin')

  test('is a LaunchAgent, which needs no password', () => {
    assert.equal(plan.kind, 'launchd')
    assert.match(plan.path, /Library\/LaunchAgents\/com\.sketchpad\.server\.plist$/)
    assert.ok(!plan.path.includes('/Library/LaunchDaemons'), 'a daemon would need root')
  })

  test('comes back if it dies, and starts at login', () => {
    assert.match(plan.contents, /<key>KeepAlive<\/key>\s*<true\/>/)
    assert.match(plan.contents, /<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  test('is valid plist, not just a string that looks like one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sketchpad-plist-'))
    try {
      const file = join(dir, 'test.plist')
      writeFileSync(file, plan.contents)
      if (process.platform !== 'darwin') return   // plutil is a macOS tool
      execFileSync('plutil', ['-lint', file], { stdio: 'pipe' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bootstraps into the login session and boots back out', () => {
    assert.equal(plan.enable[0].file, 'launchctl')
    assert.ok(plan.enable[0].args.includes('bootstrap'))
    assert.ok(plan.disable[0].args.join(' ').includes(LABEL))
  })
})

describe('Windows', () => {
  const plan = forPlatform('win32')

  test('uses the Startup folder, which needs no elevation', () => {
    assert.equal(plan.kind, 'startup-folder')
    assert.ok(plan.path.includes(join('Start Menu', 'Programs', 'Startup')), plan.path)
    assert.deepEqual(plan.enable, [], 'being in the folder is the whole mechanism')
  })

  test('starts without leaving a console window open', () => {
    assert.match(plan.contents, /^@echo off/)
    assert.ok(plan.contents.includes('/b'), 'without /b a console window stays on screen')
  })

  test('quotes the paths, because Windows paths have spaces in them', () => {
    assert.ok(plan.contents.includes(`"${NODE}"`))
    assert.ok(plan.contents.includes(`"${ENTRY}"`))
  })

  test('uses CRLF, which is what cmd expects', () => {
    assert.ok(plan.contents.includes('\r\n'))
  })
})

describe('Linux', () => {
  const plan = forPlatform('linux')

  test('is a user unit, so it needs no root', () => {
    assert.equal(plan.kind, 'systemd')
    assert.match(plan.path, /\.config\/systemd\/user\/sketchpad\.service$/)
    assert.ok(plan.enable.every(c => c.args.includes('--user')), 'every call must stay in user scope')
  })

  test('restarts on failure and is wanted by the default target', () => {
    assert.match(plan.contents, /Restart=on-failure/)
    assert.match(plan.contents, /WantedBy=default\.target/)
  })

  test('reloads the daemon before enabling, or systemd will not see the new unit', () => {
    assert.ok(plan.enable[0].args.includes('daemon-reload'))
    assert.ok(plan.enable[1].args.includes('enable'))
  })
})

describe('a login item that cannot start', () => {
  test('backs off instead of restarting in a tight loop', () => {
    // An older server still holding the port makes this exit at once. KeepAlive would then restart
    // it immediately, forever, filling the log and burning CPU for as long as the clash lasts.
    const plan = forPlatform('darwin')
    assert.match(plan.contents, /<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/)
    const seconds = Number(plan.contents.match(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/)[1])
    assert.ok(seconds >= 10, `${seconds}s is still a spin`)
  })

  test('Linux backs off too', () => {
    assert.match(forPlatform('linux').contents, /RestartSec=\d+/)
  })
})
