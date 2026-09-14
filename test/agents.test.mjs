// Who is on the other end, and the person's say in it.
//
// Before this, an agent was anonymous: the iPad knew something was listening but not what, and had
// no way to stop it. These tests are mostly about that second half — being able to shut one out has
// to actually shut it out, and stay that way.

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createAgents, agentFromHeaders, STALE_MS } from '../server/agents.mjs'

describe('the agent list', () => {
  let sent, clock, agents
  beforeEach(() => {
    sent = []
    clock = 1_700_000_000_000
    agents = createAgents({ broadcast: m => sent.push(m), now: () => clock })
  })

  test('carries what the client called itself', () => {
    agents.seen({ id: 'a1', name: 'Claude Code', version: '2.1' })
    assert.deepEqual(agents.list().map(a => [a.name, a.version]), [['Claude Code', '2.1']])
  })

  test('and where it was working, so two of the same editor are not the same row twice', () => {
    agents.seen({ id: 'a1', name: 'claude-code', where: 'sketchpad' })
    agents.seen({ id: 'a2', name: 'claude-code', where: 'ai-npc-management' })
    assert.deepEqual(agents.list().map(a => `${a.name} · ${a.where}`),
                     ['claude-code · sketchpad', 'claude-code · ai-npc-management'])
  })

  test('a client that says nothing about where it is still gets a row', () => {
    agents.seen({ id: 'a1', name: 'some-agent' })
    assert.equal(agents.list()[0].where, '')
  })

  test('tells the iPad as soon as one arrives', () => {
    agents.seen({ id: 'a1', name: 'Cursor' })
    const update = sent.find(m => m.type === 'agents')
    assert.ok(update, 'the iPad should have been told')
    assert.equal(update.agents[0].name, 'Cursor')
  })

  test('does not announce the same agent over and over', () => {
    agents.seen({ id: 'a1', name: 'Cursor' })
    for (let i = 0; i < 5; i++) agents.seen({ id: 'a1', name: 'Cursor' })
    assert.equal(sent.filter(m => m.type === 'agents').length, 1, 'every tool call would be a broadcast')
  })

  test('an agent with no name is still listed, rather than vanishing', () => {
    agents.seen({ id: 'a1' })
    assert.equal(agents.list()[0].name, 'an agent')
  })

  test('ignores a request that offers no identity at all', () => {
    assert.equal(agents.seen(null), null)
    assert.equal(agents.seen({}), null)
    assert.deepEqual(agents.list(), [])
  })

  test('is ordered by when each first appeared, so it does not jump about', () => {
    agents.seen({ id: 'a1', name: 'first' })
    clock += 1000
    agents.seen({ id: 'a2', name: 'second' })
    clock += 1000
    agents.seen({ id: 'a1', name: 'first' })   // the older one speaks again
    assert.deepEqual(agents.list().map(a => a.name), ['first', 'second'])
  })
})

describe('who is listening', () => {
  let sent, agents
  beforeEach(() => {
    sent = []
    agents = createAgents({ broadcast: m => sent.push(m) })
    agents.seen({ id: 'a1', name: 'Claude Code' })
  })

  test('shows up in the list and in the count', () => {
    agents.setWaiting('a1', true)
    assert.equal(agents.list()[0].waiting, true)
    assert.equal(agents.waiting(), 1)
  })

  test('and stops showing when it gives up', () => {
    agents.setWaiting('a1', true)
    agents.setWaiting('a1', false)
    assert.equal(agents.waiting(), 0)
  })

  test('is only announced when it actually changes', () => {
    sent.length = 0
    agents.setWaiting('a1', true)
    agents.setWaiting('a1', true)
    assert.equal(sent.length, 1)
  })
})

describe('shutting an agent out', () => {
  let agents
  beforeEach(() => {
    agents = createAgents()
    agents.seen({ id: 'a1', name: 'unwanted' })
    agents.seen({ id: 'a2', name: 'wanted' })
  })

  test('refuses it from then on', () => {
    assert.equal(agents.block('a1'), true)
    assert.equal(agents.seen({ id: 'a1', name: 'unwanted' }), null, 'it must not be able to walk back in')
    assert.equal(agents.isBlocked('a1'), true)
  })

  test('and leaves the others alone', () => {
    agents.block('a1')
    assert.ok(agents.seen({ id: 'a2', name: 'wanted' }))
    assert.deepEqual(agents.list().map(a => a.name), ['wanted'])
  })

  test('an id that is not there is not an error worth throwing over', () => {
    assert.equal(agents.block('nope'), false)
  })

  test('can be undone, for when it was a mistake', () => {
    agents.block('a1')
    agents.unblock('a1')
    assert.ok(agents.seen({ id: 'a1', name: 'unwanted' }))
  })
})

describe('agents that went away', () => {
  test('drop off the list once they have been quiet a while', () => {
    let clock = 1_700_000_000_000
    const agents = createAgents({ now: () => clock })
    agents.seen({ id: 'a1', name: 'gone' })
    clock += STALE_MS + 1
    assert.deepEqual(agents.list(), [], 'a list of agents should be a list of live ones')
  })

  test('but one still waiting is not dropped, however long it waits', () => {
    let clock = 1_700_000_000_000
    const agents = createAgents({ now: () => clock })
    agents.seen({ id: 'a1', name: 'patient' })
    agents.setWaiting('a1', true)
    clock += STALE_MS * 10
    assert.equal(agents.list().length, 1, 'wait_for_turn can legitimately block for ten minutes')
  })
})

describe('reading the agent off a request', () => {
  test('takes the name the wrapper encoded', () => {
    assert.deepEqual(
      agentFromHeaders({
        'x-sketchpad-agent-id': 'a1',
        'x-sketchpad-agent-name': encodeURIComponent('Ryan’s editor'),
        'x-sketchpad-agent-version': '1.0',
        'x-sketchpad-agent-where': encodeURIComponent('sketchpad')
      }),
      { id: 'a1', name: 'Ryan’s editor', version: '1.0', where: 'sketchpad' }
    )
  })

  test('survives a name that is not encoded properly', () => {
    const got = agentFromHeaders({ 'x-sketchpad-agent-id': 'a1', 'x-sketchpad-agent-name': '%%%broken' })
    assert.equal(got.id, 'a1')
    assert.equal(typeof got.name, 'string')
  })

  test('caps what a client can claim about itself', () => {
    const got = agentFromHeaders({
      'x-sketchpad-agent-id': 'x'.repeat(200),
      'x-sketchpad-agent-name': 'y'.repeat(200)
    })
    assert.ok(got.id.length <= 64)
    assert.ok(got.name.length <= 60)
  })

  test('is nothing at all when no identity was offered', () => {
    assert.equal(agentFromHeaders({}), null)
    assert.equal(agentFromHeaders(), null)
  })
})
