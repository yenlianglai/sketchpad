// What someone is told in order to connect an iPad.
//
// One place, because it is said in three: when the server starts, when `sketchpad pair` is run, and
// when an agent is asked for a code. Wording that drifts between them is wording that stops being
// true somewhere.

/// What the iPad needs to be told, and what it works out for itself.
///
/// Only the code is here. The address it usually finds over Bonjour, and the certificate it learns
/// during pairing — the proof it sends is bound to whatever certificate it was shown, so a wrong one
/// is rejected by the server rather than having to be checked up front.
export function pairing({ host, port, code, expiresAt, alt = [] }) {
  return {
    host: `${host}:${port}`,
    alt: alt.filter(h => h && h !== host).map(h => `${h}:${port}`),
    code: code || null,
    expiresAt: expiresAt || null
  }
}

/// True when this copy was installed rather than cloned. An installed one has its commands on the
/// PATH; a checkout only has its npm scripts.
const isLinked = () => import.meta.url.includes('/node_modules/')

/// How to set an agent up from here. Telling someone to run `sketchpad` when they cloned the repo
/// is telling them to run something they do not have.
export const setupCommand = ({ linked = isLinked() } = {}) =>
  linked ? 'sketchpad install' : 'npm run setup'

/// The lines shown to a person connecting an iPad. Returned rather than printed, so the same
/// wording can go to a terminal or back to an agent to read out.
export function pairingBanner({ host, port, code, alt = [], token, linked }) {
  const { host: address, alt: others } = pairing({ host, port, alt })
  const lines = ['']

  if (code) {
    lines.push('  iPad    open Sketchpad and type this code:', '', `      ${code}`, '',
      '          good for ten minutes, and for one iPad')
  } else if (token) {
    lines.push(`  iPad    open Sketchpad and enter this key:  ${token}`)
  } else {
    lines.push("  OPEN    no token: anyone on this network can read your canvas and this machine's files.")
  }

  lines.push('',
    `  Mac     ${address}${others.length ? `  ·  also ${others.join('  ')}` : ''}`,
    '          Sketchpad finds this on its own if your network allows it',
    '',
    `  Agent   ${setupCommand({ linked })}`,
    '')
  return lines
}

/// Printed to stderr, never stdout: in stdio mode stdout is the MCP transport.
export function printPairing(options) {
  process.stderr.write(pairingBanner(options).join('\n') + '\n')
}
