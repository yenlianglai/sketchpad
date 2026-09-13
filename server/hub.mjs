// The set of iPads currently connected, and the one way to talk to them.
//
// Everything the agent does reaches the iPad as a broadcast on this hub; nothing else in the server
// knows about sockets.

import { WebSocketServer } from 'ws'

export function createHub({ log = () => {} } = {}) {
  const sockets = new Set()
  /// Sent to an iPad the moment it connects, so it starts in the right state.
  let greeting = () => ({ type: 'hello' })

  function broadcast(message) {
    const json = JSON.stringify(message)
    for (const ws of sockets) if (ws.readyState === 1) ws.send(json)
  }

  return {
    broadcast,
    clientCount: () => sockets.size,
    onGreeting(fn) { greeting = fn },

    /// Accept `/ws` upgrades on an http server. `authorize` gets the parsed URL.
    attachTo(server, { path = '/ws', authorize = () => true } = {}) {
      const wss = new WebSocketServer({ noServer: true })
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://x')
        if (url.pathname !== path || !authorize(url)) { socket.destroy(); return }
        wss.handleUpgrade(req, socket, head, ws => {
          sockets.add(ws)
          log(`iPad connected (${sockets.size} now)`)
          try { ws.send(JSON.stringify(greeting())) } catch {}
          ws.on('close', () => { sockets.delete(ws); log(`iPad disconnected (${sockets.size} left)`) })
        })
      })
    }
  }
}
