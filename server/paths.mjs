// Where Sketchpad puts things on each platform. Nothing goes next to the code: installed from npm
// that would be inside node_modules, where an update throws it away.

import { homedir } from 'node:os'
import { join } from 'node:path'

/// Settings that should outlive a cache clear — the token lives here.
export function configHome() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/// Throwaway: deleting any of it loses nothing, because the iPad holds what you drew.
export function cacheHome() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches')
  if (process.platform === 'win32') return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
}

export const configDir = () => join(configHome(), 'sketchpad')
export const spoolDir = () => process.env.SKETCHPAD_SPOOL_DIR || join(cacheHome(), 'sketchpad')
export const serverLogPath = () => join(spoolDir(), 'server.log')
