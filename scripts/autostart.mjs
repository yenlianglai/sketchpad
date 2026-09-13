// Starting the server when you log in, on each platform's own terms.
//
// Every platform boils down to the same two things: a file somewhere, and a command to tell the
// system about it. So this module only builds that plan — writing it and running it is install.mjs's
// job. That keeps the part that differs per platform testable on any platform.

import { join } from 'node:path'

export const LABEL = 'com.sketchpad.server'

/// What to write and what to run so `entry` starts at login. `platform`, `home` and `configHome`
/// are parameters rather than lookups so every platform's plan can be inspected from any machine.
export function autostartPlan({
  platform = process.platform,
  node = process.execPath,
  entry,
  home,
  configHome
}) {
  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`)
    return {
      platform, path, kind: 'launchd',
      // KeepAlive rather than RunAtLoad alone: if it dies, it should come back without a login.
      contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entry}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Something else holding the port makes this exit immediately; without a throttle launchd
       would restart it in a tight loop for as long as that lasts. -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`,
      enable: [{ file: 'launchctl', args: ['bootstrap', `gui/${process.getuid?.() ?? 501}`, path] }],
      disable: [{ file: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`] }]
    }
  }

  if (platform === 'win32') {
    // The Startup folder needs no elevation and no scheduled-task privileges, which Task Scheduler
    // would. A .cmd there runs at login like anything else the user put in it.
    const path = join(configHome, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'sketchpad.cmd')
    return {
      platform, path, kind: 'startup-folder',
      contents: `@echo off\r\nstart "" /b "${node}" "${entry}"\r\n`,
      enable: [],      // being in the folder is the whole mechanism
      disable: []
    }
  }

  const path = join(configHome, 'systemd', 'user', 'sketchpad.service')
  return {
    platform, path, kind: 'systemd',
    contents: `[Unit]
Description=Sketchpad — draw on an iPad, your coding agent answers
After=network.target

[Service]
ExecStart=${node} ${entry}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
    enable: [
      { file: 'systemctl', args: ['--user', 'daemon-reload'] },
      { file: 'systemctl', args: ['--user', 'enable', '--now', 'sketchpad.service'] }
    ],
    disable: [{ file: 'systemctl', args: ['--user', 'disable', '--now', 'sketchpad.service'] }]
  }
}
