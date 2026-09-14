// Who is on the other end.
//
// An agent used to be anonymous: the iPad could see that *something* was listening, but not what,
// and had no say in it. That is the wrong shape for a thing you hand your drawings to. Each agent
// now arrives with a name, shows up in a list on the iPad, can be told which pages it may have, and
// can be shut out.
//
// Identity comes from MCP's own `clientInfo`, forwarded by the stdio wrapper — so it is what the
// client calls itself, not something we invented. Treat it as a label, not a credential: everything
// reaching this far has already presented the machine's token.

/// Forgotten after this long without a word, so a list of agents is a list of live ones.
///
/// The wrapper says hello once a minute precisely so that "no word" means gone rather than merely
/// idle — a client in the middle of a conversation can call nothing for a long time, and it used to
/// vanish from the iPad while still connected. Five missed hellos is the margin.
export const STALE_MS = 5 * 60 * 1000

export function createAgents({ broadcast = () => {}, now = () => Date.now() } = {}) {
  const agents = new Map()   // id → record
  const blocked = new Set()  // ids the person has shut out, for as long as this server runs

  const publish = () => broadcast({ type: 'agents', agents: list(), listening: list().some(a => a.waiting) })

  /// Record that this agent just did something. Returns its record, or null if there is nothing to
  /// record — no identity offered — or if it has been shut out.
  function seen(info) {
    const { id, name, version, where } = info ?? {}
    if (!id) return null
    if (blocked.has(id)) return null

    const existing = agents.get(id)
    const agent = existing ?? { id, name: name || 'an agent', version: version || '', where: where || '', firstSeen: now(), waiting: false }
    agent.name = name || agent.name
    agent.version = version || agent.version
    agent.where = where || agent.where
    agent.lastSeen = now()
    agents.set(id, agent)
    if (!existing) publish()
    return agent
  }

  /// Whether this agent is blocked in wait_for_turn. Drives the light on the iPad, and decides who
  /// a page can be handed to.
  function setWaiting(id, waiting) {
    const agent = agents.get(id)
    if (!agent || agent.waiting === waiting) return
    agent.waiting = waiting
    agent.lastSeen = now()
    publish()
  }

  /// Shut an agent out. It stays out until the server restarts — long enough to stop something you
  /// did not expect, short of a permanent ban nobody remembers setting.
  function block(id) {
    if (!agents.has(id) && !blocked.has(id)) return false
    blocked.add(id)
    agents.delete(id)
    publish()
    return true
  }
  const unblock = id => blocked.delete(id)

  function prune() {
    let changed = false
    for (const [id, agent] of agents) {
      if (!agent.waiting && now() - agent.lastSeen > STALE_MS) { agents.delete(id); changed = true }
    }
    if (changed) publish()
  }

  function list() {
    prune()
    return [...agents.values()]
      .sort((a, b) => a.firstSeen - b.firstSeen)
      .map(({ id, name, version, where, waiting, firstSeen, lastSeen }) => ({ id, name, version, where, waiting, firstSeen, lastSeen }))
  }

  return {
    seen,
    setWaiting,
    block,
    unblock,
    list,
    isBlocked: id => blocked.has(id),
    waiting: () => list().filter(a => a.waiting).length,
    has: id => agents.has(id)
  }
}

/// What the stdio wrapper puts on every request, read back here. Names are percent-encoded because
/// a client is free to call itself anything, and headers are not.
export function agentFromHeaders(headers = {}) {
  const id = headers['x-sketchpad-agent-id']
  if (!id) return null
  const decode = v => { try { return decodeURIComponent(v ?? '') } catch { return v ?? '' } }
  return {
    id: String(id).slice(0, 64),
    name: decode(headers['x-sketchpad-agent-name']).slice(0, 60),
    version: decode(headers['x-sketchpad-agent-version']).slice(0, 30),
    // Where the client was working when it started us. Two sessions of the same editor are otherwise
    // indistinguishable on the iPad, which is the case you most need to tell apart.
    where: decode(headers['x-sketchpad-agent-where']).slice(0, 40)
  }
}
