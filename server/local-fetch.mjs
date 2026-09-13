// Talking to the sketchpad on this machine, over its own self-signed certificate.
//
// Node's fetch has no way to trust one certificate for one host without a dependency, and turning
// verification off globally would be a poor trade for a convenience. So this is a small fetch built
// on node:https that trusts exactly the certificate the server wrote — nothing else, and nothing
// outside this process.

import { request } from 'node:https'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './paths.mjs'

/// The certificate the server on this machine is using, if it is using one.
export function localCert({ dir = configDir() } = {}) {
  try {
    return readFileSync(join(dir, 'cert.pem'), 'utf8')
  } catch {
    return null   // running without TLS, or nothing has started yet
  }
}

/// fetch, but for our own server: verified against its certificate rather than the public CA list.
/// Falls through to plain http when the URL says so, which is what SKETCHPAD_NO_TLS leaves behind.
export function localFetch({ ca = localCert() } = {}) {
  return function fetchLocal(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
    const secure = url.protocol === 'https:'
    const send = secure ? request : httpRequest

    return new Promise((resolve, reject) => {
      const req = send(url, {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
        ...(secure
          ? {
              ca: ca ?? undefined,
              // The certificate names the machine, not "127.0.0.1" as a hostname — pinning the
              // certificate itself is what matters here, so skip the name match but keep the
              // signature check that `ca` performs.
              checkServerIdentity: () => undefined
            }
          : {})
      }, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve(new Response(body, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: Object.entries(res.headers).reduce((h, [k, v]) => {
              if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : v
              return h
            }, {})
          }))
        })
      })

      req.on('error', reject)
      if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      if (init.body) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body))
      req.end()
    })
  }
}

/// Where the sketchpad on this machine is, https unless it was told otherwise.
export const localURL = (env = process.env) =>
  (env.SKETCHPAD_URL || `${env.SKETCHPAD_NO_TLS === '1' ? 'http' : 'https'}://127.0.0.1:${env.SKETCHPAD_PORT ?? 8791}`)
    .replace(/\/+$/, '')
