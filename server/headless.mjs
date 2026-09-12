// Headless driver: instead of pushing turns into an existing Claude Code
// session via channels (needs org policy), spawn our own `claude -p` with
// stream-json on both ends and keep stdin open for multi-turn.
// Works with a plain claude.ai subscription login; no admin setting required.
import { spawn } from 'node:child_process'

export function createHeadlessDriver({ cwd, instructions, onEvent, log, resume, permissionMode, extraArgs = [] }) {
  // No permission mode by default: nobody is at the terminal to answer prompts, so anything
  // that would prompt is simply denied. Looking at the sketch and replying needs no approval.
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    // Ignore the project's .mcp.json: otherwise Claude spawns a second copy of this server
    // (channel driver) and tries to call its `reply` tool, which nobody can approve here.
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--append-system-prompt', instructions,
    ...(resume ? ['--resume', resume] : []),
    ...extraArgs
  ]
  // Do not inherit session markers from a parent Claude Code process (nested-session guards).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE'))
  const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let sessionId = null, buf = ''
  log(`headless: spawned claude (pid ${child.pid}) in ${cwd}`)

  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { log('headless: non-json line', line.slice(0, 120)); continue }
      handle(msg)
    }
  })
  child.stderr.on('data', d => log('headless stderr:', d.toString().trim().slice(0, 300)))
  child.on('exit', (code, sig) => { log(`headless: claude exited code=${code} sig=${sig}`); onEvent({ type: 'exit', code }) })

  function handle(msg) {
    if (msg.session_id && !sessionId) { sessionId = msg.session_id; log('headless: session', sessionId) }
    if (msg.type === 'system' && msg.subtype === 'init') onEvent({ type: 'ready', sessionId, model: msg.model })
    if (msg.type === 'assistant' && msg.parent_tool_use_id == null) {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text.trim()) onEvent({ type: 'text', text: block.text })
        if (block.type === 'tool_use') onEvent({ type: 'tool', name: block.name, input: block.input })
      }
    }
    if (msg.type === 'result') {
      const ok = msg.subtype === 'success' && !msg.is_error
      onEvent({ type: 'result', ok, costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, error: ok ? undefined : (msg.result || msg.subtype) })
    }
  }

  return {
    get sessionId() { return sessionId },
    alive: () => child.exitCode === null,
    sendTurn({ turnId, text, pngPath, pngBase64 }) {
      const content = []
      const said = text?.trim()
      content.push({ type: 'text', text: `<turn id="${turnId}"${pngPath ? ` sketch_path="${pngPath}"` : ''}>${said || '(no speech; respond to the drawing)'}</turn>` })
      if (pngBase64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } })
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
    },
    close() { try { child.stdin.end() } catch {} setTimeout(() => child.kill('SIGINT'), 2000) }
  }
}
