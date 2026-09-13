// The README, checked against the thing it describes.
//
// Walking it as a new user turned up instructions that had quietly stopped being true: a command
// that was not on the PATH, a QR code that no longer existed, an http URL after the move to TLS.
// None of that shows up in a test suite that only exercises the code, and none of it is visible to
// the person who wrote it. So the claims get checked here instead.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS } from '../server/tools.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const CONTRIBUTING = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const CLI = readFileSync(join(ROOT, 'scripts', 'cli.mjs'), 'utf8')

/// Commands appear both inline (`npm run pair`) and in fenced blocks, and the fenced ones are the
/// ones people actually copy — so scan the prose and the blocks together.
const FENCED = [...README.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]).join('\n')
const EVERYTHING = README + '\n' + FENCED
const mentioned = pattern => [...new Set([...EVERYTHING.matchAll(pattern)].map(m => m[1]))]

describe('every command the README gives', () => {
  test('is an npm script that exists', () => {
    for (const script of mentioned(/(?:^|[`\s])npm run ([a-z-]+)/gm)) {
      assert.ok(pkg.scripts[script], `README says \`npm run ${script}\`, package.json has no such script`)
    }
  })

  test('is a subcommand the CLI answers to', () => {
    // The command table in cli.mjs is the list of what `sketchpad <x>` accepts.
    const table = CLI.slice(CLI.indexOf('const commands = {'))
    for (const command of mentioned(/(?:^|[`\s])sketchpad (?:-- )?([a-z]+)/gm)) {
      if (command === 'mcp') continue   // sketchpad-mcp is the other binary
      assert.match(table, new RegExp(`\\b${command}\\b`), `README says \`sketchpad ${command}\``)
    }
  })

  test('and the binaries it names are declared', () => {
    for (const bin of ['sketchpad-mcp']) {
      assert.ok(!README.includes(bin) || pkg.bin[bin], `README names ${bin}`)
    }
  })
})

describe('the tool table', () => {
  test('lists every tool an agent is offered', () => {
    for (const { name } of TOOLS) {
      assert.ok(README.includes(name), `${name} is offered to agents but not documented`)
    }
  })

  test('and offers no tool that does not exist', () => {
    const names = TOOLS.map(t => t.name)
    for (const claimed of mentioned(/`(sketchpad_[a-z_]+)`/g)) {
      assert.ok(names.includes(claimed), `README documents ${claimed}, which no longer exists`)
    }
  })
})

describe('the environment table', () => {
  test('names only variables the server actually reads', () => {
    const source = ['index', 'auth', 'paths', 'local-fetch', 'addresses', 'mcp-stdio']
      .map(f => readFileSync(join(ROOT, 'server', `${f}.mjs`), 'utf8')).join('\n')
    for (const variable of mentioned(/`(SKETCHPAD_[A-Z_]+)`/g)) {
      assert.ok(source.includes(variable), `README documents ${variable}, which nothing reads`)
    }
  })
})

describe('every file the docs link to', () => {
  test('is really there', () => {
    const links = [...README.matchAll(/]\((?!https?:)([^)#]+)\)/g), ...README.matchAll(/src="(?!https?:)([^"]+)"/g)]
    assert.ok(links.length > 3, 'expected the README to link to something')
    for (const [, path] of links) {
      assert.ok(existsSync(join(ROOT, path)), `README links to ${path}, which does not exist`)
    }
  })
})

describe('nothing describes a feature that was removed', () => {
  test('the QR code is gone from the docs as well as the code', () => {
    for (const [name, text] of [['README', README], ['CONTRIBUTING', CONTRIBUTING]]) {
      assert.ok(!/\bQR\b/i.test(text), `${name}.md still mentions a QR code`)
    }
  })

  test('and so is the dependency that drew it', () => {
    assert.ok(!pkg.dependencies['qrcode-terminal'])
  })
})
