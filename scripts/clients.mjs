// Where each MCP client keeps its config, on each platform.
//
// Kept apart from register.mjs so it can be tested without writing to anybody's real config: a
// wrong path here fails silently as "client not installed", which is the worst way for this to
// be wrong.

import { join } from 'node:path'
import { homedir } from 'node:os'
import { configHome } from '../server/paths.mjs'

/// Claude Desktop and VS Code follow the platform's own config location — which `configHome()`
/// already knows. Cursor and Windsurf use a dotfile in the home directory on every platform.
export function mcpClients({ config = configHome(), home = homedir() } = {}) {
  return [
    { id: 'claude-code', label: 'Claude Code', kind: 'cli' },
    { id: 'claude-desktop', label: 'Claude Desktop', kind: 'json', key: 'mcpServers', path: join(config, 'Claude', 'claude_desktop_config.json') },
    { id: 'cursor', label: 'Cursor', kind: 'json', key: 'mcpServers', path: join(home, '.cursor', 'mcp.json') },
    { id: 'windsurf', label: 'Windsurf', kind: 'json', key: 'mcpServers', path: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { id: 'vscode', label: 'VS Code', kind: 'json', key: 'servers', path: join(config, 'Code', 'User', 'mcp.json') }
  ]
}

/// How this platform asks "is this command on the PATH?".
export const whichCommand = (name, platform = process.platform) =>
  platform === 'win32' ? { file: 'where', args: [name] } : { file: 'sh', args: ['-lc', `command -v ${name}`] }
