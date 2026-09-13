// Everything Sketchpad remembers: the queue of pages waiting for an agent, the reply history, and
// which page the iPad has open. No MCP, no HTTP — so it can be tested on its own.

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

/// An agent counts as listening while one is blocked in wait_for_turn, and for a while after, so
/// the gap between two polls does not flicker the iPad's status light.
export const LISTEN_GRACE_MS = 90_000
export const PUBLISHABLE = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.pdf']
const MAX_FILE_BYTES = 50 * 1024 * 1024

export function createState({ broadcast, clientCount, inboxDir, outboxDir, now = () => Date.now() }) {
  const queue = []             // pages sent but not yet taken by an agent
  const waiters = []           // resolvers of pending wait_for_turn calls
  const snapshots = new Map()  // request id → resolve(pngBase64 | null)
  let lastTurn = null
  let currentBoard = null      // { id, title } of the page the iPad has open

  // The manifest is a plain file beside the PNGs, so the history is readable without this process.
  const manifestPath = join(inboxDir, 'turns.json')
  const manifest = readManifest(manifestPath)
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 1))

  // MARK: turns

  function pushTurn(turn) {
    lastTurn = turn
    if (turn.boardId) currentBoard = { id: turn.boardId, title: turn.boardTitle || currentBoard?.title || '' }
    manifest.push({
      turnId: turn.turnId, boardId: turn.boardId ?? null, boardTitle: turn.boardTitle ?? null,
      ts: turn.ts ?? now(), text: turn.text ?? '', strokes: turn.strokes ?? null,
      pngPath: turn.pngPath ?? null, replies: []
    })
    save()
    queue.push(turn)
    waiters.shift()?.()
  }

  /// Resolves with the next page, or null if none arrives in time.
  function takeTurn(timeoutMs) {
    touchListening()
    if (queue.length) return Promise.resolve(queue.shift())
    return new Promise(resolve => {
      const finish = value => {
        const i = waiters.indexOf(wake)
        if (i >= 0) waiters.splice(i, 1)
        touchListening()
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), timeoutMs)
      const wake = () => { clearTimeout(timer); finish(queue.shift() ?? null) }
      waiters.push(wake)
      touchListening()
    })
  }

  function listTurns({ boardId, limit = 20 } = {}) {
    const board = boardId ?? currentBoard?.id
    return manifest
      .filter(t => boardId === 'all' || !board || t.boardId === board)
      .slice(-limit)
      .reverse()
  }
  const getTurn = turnId => manifest.find(t => t.turnId === turnId) ?? null

  // MARK: replies

  function recordReply(turnId, reply) {
    const record = manifest.find(t => t.turnId === turnId) ?? manifest.at(-1)
    if (!record) return
    record.replies.push(reply)
    save()
  }

  /// Replies newer than `sinceMs`, oldest first, so an iPad that was asleep or offline picks up what
  /// it missed instead of losing it.
  function recentReplies(sinceMs = 0, limit = 30) {
    const out = []
    for (const turn of manifest)
      for (const reply of turn.replies)
        if ((reply.ts ?? 0) > sinceMs) out.push({ ...reply, turnId: reply.turnId ?? turn.turnId })
    out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    return out.slice(-limit)
  }

  // MARK: the page the iPad has open

  function setTitle(title, boardId) {
    const id = boardId ?? currentBoard?.id
    if (currentBoard && (!boardId || boardId === currentBoard.id)) currentBoard.title = title
    broadcast({ type: 'title', boardId: id, title })
  }

  // MARK: snapshots

  /// Ask the iPad for a picture of the canvas as it is right now.
  function requestSnapshot(timeoutMs = 4000) {
    if (clientCount() === 0) return Promise.resolve(null)
    const id = randomUUID().slice(0, 8)
    return new Promise(resolve => {
      const timer = setTimeout(() => { snapshots.delete(id); resolve(null) }, timeoutMs)
      snapshots.set(id, png => { clearTimeout(timer); snapshots.delete(id); resolve(png) })
      broadcast({ type: 'snapshot_request', id })
    })
  }
  const resolveSnapshot = (id, pngBase64) => snapshots.get(id)?.(pngBase64 || null)

  // MARK: files the agent hands over

  /// Copy it into outbox so the iPad can fetch it over /files/.
  function publishFile(path) {
    const ext = extname(path).toLowerCase()
    if (!PUBLISHABLE.includes(ext)) throw new Error(`unsupported file type ${ext || '(none)'}; use ${PUBLISHABLE.join(' ')}`)
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`file too large: ${path}`)
    mkdirSync(outboxDir, { recursive: true })
    const name = `${now()}-${basename(path)}`
    copyFileSync(path, join(outboxDir, name))
    return { url: `/files/${name}`, name: basename(path) }
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
    pushTurn, takeTurn, listTurns, getTurn,
    recordReply, recentReplies,
    setTitle, requestSnapshot, resolveSnapshot, publishFile,
    pending: () => queue.length,
    isListening: () => listening,
    get lastTurn() { return lastTurn },
    get currentBoard() { return currentBoard },
    get turnsRecorded() { return manifest.length }
  }
}

function readManifest(path) {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []   // a corrupt manifest should cost you history, not the ability to draw
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
