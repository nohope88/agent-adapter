import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { PATHS, isWindows } from '../util/paths';
import { stableNode } from '../util/node';
import { logger } from '../util/log';

const log = logger('install');

function startArgs(): string[] {
  // The daemon runs the headless adapter only. The web dashboard is opt-in
  // (`agent-adapter start --web`), never part of the installed service.
  if (process.env.AGENT_ADAPTER_BIN) return [process.env.AGENT_ADAPTER_BIN, 'start'];
  const exec = stableNode();
  if (path.basename(exec).includes('aca')) return [exec, 'start'];
  return [exec, path.resolve(__dirname, '..', 'cli.js'), 'start'];
}

export function registerPlatformDaemon(): void {
  if (process.env.AGENT_ADAPTER_SKIP_DAEMON) return;
  try {
    if (process.platform === 'darwin') registerLaunchd();
    else if (process.platform === 'linux') registerSystemd();
    else if (isWindows) registerSchtasks();
  } catch (e) {
    log.warn('daemon registration failed (run `agent-adapter start` manually)', String(e));
  }
}

export type StopResult =
  | { kind: 'unsupported' }
  | { kind: 'stopped'; target: string }
  | { kind: 'not-running'; target: string };

/** The service-manager command that stops the installed daemon on `platform`,
 *  or null where we register no service. Pure (no spawning) so it's unit-tested
 *  for every platform on one OS; `stopPlatformDaemon` runs it. */
export function stopCommand(
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[]; target: string } | null {
  if (platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agent-adapter.plist');
    // KeepAlive=true means `launchctl stop` just relaunches — `unload` is the
    // only way to actually stop it.
    return { cmd: 'launchctl', args: ['unload', plist], target: plist };
  }
  if (platform === 'linux') {
    return { cmd: 'systemctl', args: ['--user', 'stop', 'agent-adapter.service'], target: 'agent-adapter.service' };
  }
  if (platform === 'win32') {
    return { cmd: 'schtasks', args: ['/End', '/TN', 'AgentAdapter'], target: 'AgentAdapter' };
  }
  return null;
}

export function stopPlatformDaemon(): StopResult {
  const c = stopCommand();
  if (!c) return { kind: 'unsupported' };
  if (process.env.AGENT_ADAPTER_SKIP_DAEMON) return { kind: 'stopped', target: c.target };
  // On macOS the unit is a plist file; if it's absent the adapter was never
  // installed as a service (likely a foreground `aca start`).
  if (process.platform === 'darwin' && !fs.existsSync(c.target)) return { kind: 'not-running', target: c.target };
  try {
    execFileSync(c.cmd, c.args, { stdio: 'ignore' });
    log.info(`daemon stopped: ${c.target}`);
    return { kind: 'stopped', target: c.target };
  } catch (e) {
    log.warn(`stop: ${c.cmd} ${c.args.join(' ')} failed (already stopped?)`, String(e));
    return { kind: 'not-running', target: c.target };
  }
}

function registerLaunchd(): void {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.agent-adapter.plist');
  const [prog, ...args] = startArgs();
  const argXml = [prog, ...args].map((a) => `    <string>${esc(a)}</string>`).join('\n');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agent-adapter</string>
  <key>ProgramArguments</key><array>
${argXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${esc(PATHS.log)}</string>
  <key>StandardOutPath</key><string>${esc(PATHS.log)}</string>
</dict></plist>\n`);
  try { execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch { /* noop */ }
  execFileSync('launchctl', ['load', plist], { stdio: 'ignore' });
  log.info(`launchd service installed: ${plist}`);
}

function registerSystemd(): void {
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const unit = path.join(dir, 'agent-adapter.service');
  const exec = startArgs().map(q).join(' ');
  fs.writeFileSync(unit, `[Unit]
Description=Agent Adapter
After=network.target

[Service]
ExecStart=${exec}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`);
  try { execFileSync('systemctl', ['--user', 'enable', '--now', 'agent-adapter.service'], { stdio: 'ignore' }); }
  catch (e) { log.warn('systemctl enable failed', String(e)); }
  log.info(`systemd user service installed: ${unit}`);
}

function registerSchtasks(): void {
  const cmd = startArgs().map(q).join(' ');
  execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'AgentAdapter', '/TR', cmd], { stdio: 'ignore' });
  log.info('scheduled task AgentAdapter created (onlogon)');
}

function q(s: string): string { return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s; }
function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
