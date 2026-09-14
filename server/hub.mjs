// The set of iPads currently connected, and the one way to talk to them.
//
// Everything the agent does reaches the iPad as a broadcast on this hub; nothing else in the server
// knows about sockets.

import { WebSocketServer } from 'ws'

/// How often each iPad is asked to prove it is still there, and therefore how stale
/// "connected" can be before it is corrected.
export const HEARTBEAT_MS = 20_000

export function createHub({ log = () => {}, now = () => Date.now(), heartbeatMs = HEARTBEAT_MS } = {}) {
  const sockets = new Set()
  const lastHeard = new WeakMap()   // socket → when it last answered, for reporting freshness
  const unanswered = new WeakSet()  // socket → we pinged and it has not replied since
  /// Sent to an iPad the moment it connects, so it starts in the right state.
  let greeting = () => ({ type: 'hello' })

  function broadcast(message) {
    const json = JSON.stringify(message)
    for (const ws of sockets) if (ws.readyState === 1) ws.send(json)
  }

  /// Take a connected socket into the set and start watching it. Separate from the upgrade
  /// handling so the watching can be tested without a live server.
  function track(ws) {
    sockets.add(ws)
    lastHeard.set(ws, now())
    log(`iPad connected (${sockets.size} now)`)
    try { ws.send(JSON.stringify(greeting())) } catch { /* it can go before the greeting lands */ }
    const heard = () => { lastHeard.set(ws, now()); unanswered.delete(ws) }
    ws.on('pong', heard)
    ws.on('message', heard)
    ws.on('close', () => {
      sockets.delete(ws); unanswered.delete(ws)
      log(`iPad disconnected (${sockets.size} left)`)
    })
    return ws
  }

  /// Drop anything that has stopped answering.
  ///
  /// A socket only fires `close` when the other end closes it politely. An iPad that goes out of
  /// range, sleeps or is killed leaves a half-open connection that stays in this set for as long as
  /// the operating system keeps it — so agents are told an iPad is there, pages are broadcast into
  /// nothing, and a canvas snapshot waits out its timeout for a device that left.
  /// The judgement is "did you answer the ping I sent last time", not "how long since I heard from
  /// you". Wall-clock would condemn healthy sockets whenever this did not run on schedule — a
  /// suspended process, a blocked event loop — and drop everyone on the next tick.
  function sweep() {
    for (const ws of sockets) {
      if (unanswered.has(ws)) {
        log('iPad stopped answering — dropping it')
        unanswered.delete(ws)
        sockets.delete(ws)
        try { ws.terminate() } catch { /* already gone */ }
        continue
      }
      unanswered.add(ws)
      try { ws.ping() } catch { /* unanswered now; the next sweep drops it */ }
    }
  }
  const heartbeat = setInterval(sweep, heartbeatMs)
  heartbeat.unref?.()

  return {
    broadcast,
    clientCount: () => sockets.size,
    /// How long ago the most recent iPad last proved it was there. Null when none is connected.
    quietFor: () => {
      let best = null
      for (const ws of sockets) {
        const seen = lastHeard.get(ws)
        if (seen != null && (best === null || now() - seen < best)) best = now() - seen
      }
      return best
    },
    sweep,
    track,
    stop: () => clearInterval(heartbeat),
    onGreeting(fn) { greeting = fn },

    /// Accept `/ws` upgrades on an http server. `authorize` gets the request and the parsed URL.
    attachTo(server, { path = '/ws', authorize = () => true } = {}) {
      const wss = new WebSocketServer({ noServer: true })
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://x')
        if (url.pathname !== path || !authorize(req, url)) { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, ws => track(ws))
      })
    }
  }
}
