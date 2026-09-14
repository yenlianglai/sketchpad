// What the server holds while things are in flight. Nothing here is a record.
//
// The iPad owns the pages, the strokes and the history; it is the only durable store. This process
// is a relay: it holds a page until an agent takes it, holds a file until the iPad fetches it, and
// holds a reply until the iPad is back to receive it. Anything the agent wants to look back at is
// asked of the iPad over the same round-trip the canvas snapshot uses.

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join, basename, extname, isAbsolute } from 'node:path'

/// An agent counts as listening while one is blocked in wait_for_turn, and for a while after, so
/// the gap between two polls does not flicker the iPad's status light.
export const LISTEN_GRACE_MS = 90_000
/// How long a spooled file or reply is kept for an iPad that has not come back.
export const SPOOL_TTL_MS = 24 * 60 * 60 * 1000
const PUBLISHABLE = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.pdf']
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_PENDING_REPLIES = 50

export function createState({ broadcast, clientCount, spoolDir, now = () => Date.now() }) {
  const queue = []             // pages sent but not yet taken by an agent
  const waiters = []           // resolvers of pending wait_for_turn calls
  const asked = new Map()      // request id → resolve(answer | null), for anything we ask the iPad
  let lastTurn = null
  let currentBoard = null      // { id, title } of the page the iPad has open

  const filesDir = join(spoolDir, 'files')
  const pagesDir = join(spoolDir, 'pages')
  const repliesPath = join(spoolDir, 'undelivered.json')
  for (const dir of [filesDir, pagesDir]) mkdirSync(dir, { recursive: true })

  // Replies the iPad has not had a chance to receive. Kept across a restart so a reply sent while
  // the iPad was asleep is not simply lost.
  let undelivered = readJSON(repliesPath, [])
  const saveUndelivered = () => writeFileSync(repliesPath, JSON.stringify(undelivered))

  // MARK: pages in flight

  /// A working copy of the page an agent is about to look at, so a tool that only takes a path can
  /// open it. It is not the record — the iPad keeps that — and prune() clears it out within a day.
  function spoolPage(turnId, base64) {
    const path = join(pagesDir, `${turnId}.png`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return path
  }

  function pushTurn(turn) {
    lastTurn = turn
    if (turn.boardId) currentBoard = { id: turn.boardId, title: turn.boardTitle || currentBoard?.title || '' }
    queue.push(turn)
    // Offer it around: a waiter it is not addressed to declines, and the next one is asked.
    for (const wake of [...waiters]) if (wake()) break
  }

  /// The first page this agent is allowed to take: anything unaddressed, or addressed to it.
  ///
  /// A page the person sent to one agent in particular stays in the queue until that agent asks for
  /// it, rather than being taken by whoever happened to be listening.
  function claim(agentId) {
    const i = queue.findIndex(t => !t.agentId || t.agentId === agentId)
    return i < 0 ? null : queue.splice(i, 1)[0]
  }

  /// Resolves with the next page this agent may have, or null if none arrives in time.
  function takeTurn(timeoutMs, agentId = null) {
    touchListening()
    const ready = claim(agentId)
    if (ready) return Promise.resolve(ready)
    return new Promise(resolve => {
      const finish = value => {
        const i = waiters.indexOf(wake)
        if (i >= 0) waiters.splice(i, 1)
        touchListening()
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      const wake = () => {
        const mine = claim(agentId)
        if (!mine) return false      // addressed to someone else; keep waiting
        clearTimeout(timer)
        finish(mine)
        return true
      }
      waiters.push(wake)
      touchListening()
    })
  }

  // MARK: asking the iPad

  /// Ask the connected iPad something and wait for its answer. The iPad is the only place the
  /// history lives, so every look-back goes through here.
  function ask(kind, params = {}, timeoutMs = 6000) {
    if (clientCount() === 0) return Promise.resolve(null)
    const id = randomUUID().slice(0, 8)
    return new Promise(resolve => {
      const timer = setTimeout(() => { asked.delete(id); resolve(null) }, timeoutMs)
      asked.set(id, answer => { clearTimeout(timer); asked.delete(id); resolve(answer) })
      broadcast({ type: 'ask', id, kind, ...params })
    })
  }
  const answer = (id, value) => asked.get(id)?.(value ?? null)

  /// null when nobody answered; { png } — possibly without one, for a blank canvas — when they did.
  const requestSnapshot = (timeoutMs = 4000) => ask('canvas', {}, timeoutMs)

  // MARK: replies waiting for the iPad

  function recordReply(reply) {
    undelivered.push(reply)
    if (undelivered.length > MAX_PENDING_REPLIES) undelivered = undelivered.slice(-MAX_PENDING_REPLIES)
    saveUndelivered()
  }

  /// What the iPad missed. It dedupes by reply id, so overlap is harmless.
  function repliesSince(sinceMs = 0) {
    prune()
    return undelivered.filter(r => (r.ts ?? 0) > sinceMs).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  }

  // MARK: files in flight

  /// Copy a file the agent produced into the spool so the iPad can fetch it over /files/.
  function publishFile(path) {
    // Agents hand over whatever their own renderer returned, and plenty of those return a path
    // relative to the agent's project. This process was very likely started by a login item, so its
    // working directory is meaningless — say that, rather than letting it fail as a bare ENOENT.
    if (!isAbsolute(path)) {
      throw new Error(`image_path must be absolute, got "${path}" — this server's working directory is not your project's`)
    }
    const ext = extname(path).toLowerCase()
    if (!PUBLISHABLE.includes(ext)) throw new Error(`unsupported file type ${ext || '(none)'}; use ${PUBLISHABLE.join(' ')}`)
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`file too large: ${path}`)
    const name = `${now()}-${basename(path)}`
    copyFileSync(path, join(filesDir, name))
    return { url: `/files/${name}`, name: basename(path) }
  }
  const spooledFile = name => join(filesDir, basename(name))

  /// Drop anything the iPad has had a day to collect.
  function prune() {
    const cutoff = now() - SPOOL_TTL_MS
    const before = undelivered.length
    undelivered = undelivered.filter(r => (r.ts ?? 0) > cutoff)
    if (undelivered.length !== before) saveUndelivered()
    for (const dir of [filesDir, pagesDir]) {
      try {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name)
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
        }
      } catch { /* the spool is disposable; failing to tidy it is not worth an error */ }
    }
  }

  // MARK: is an agent in the loop?

  let lastWaitAt = 0
  let listening = false
  let graceTimer = null

  function touchListening() {
    lastWaitAt = now()
    updateListening()
  }
  function updateListening() {
    clearTimeout(graceTimer)
    const active = waiters.length > 0 || now() - lastWaitAt < LISTEN_GRACE_MS
    if (active !== listening) {
      listening = active
      broadcast({ type: 'agents', listening })
    }
    // Nobody is blocked, so nothing will wake us: check again when the grace period runs out.
    if (active && waiters.length === 0) {
      graceTimer = setTimeout(updateListening, Math.max(1000, LISTEN_GRACE_MS - (now() - lastWaitAt) + 500))
      graceTimer.unref?.()
    }
  }

  return {
    pushTurn, takeTurn, spoolPage,
    ask, answer, requestSnapshot,
    recordReply, repliesSince,
    publishFile, spooledFile, prune,
    pending: () => queue.length,
    /// Worked out on the spot rather than read from the last broadcast — the cached value is only
    /// there to notice a change worth telling the iPad about, and it goes stale if the timer that
    /// maintains it has not fired yet.
    isListening: () => waiters.length > 0 || now() - lastWaitAt < LISTEN_GRACE_MS,
    /// How many agents are blocked in wait_for_turn right now. More than one means they are
    /// competing for the next page, and only one of them will get it.
    waiting: () => waiters.length,
    get lastTurn() { return lastTurn },
    get currentBoard() { return currentBoard }
  }
}

function readJSON(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) === Array.isArray(fallback) ? parsed : fallback
  } catch {
    return fallback
  }
}

/// Width×height straight out of a PNG's IHDR, for telling the agent the coordinate space it may
/// draw back in.
export function pngSize(base64) {
  try {
    const b = Buffer.from(base64.slice(0, 64), 'base64')
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
  } catch {
    return '?'
  }
}
