import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { ALL_ADAPTERS, detected } from '../adapters/registry';
import { AdapterDescriptor, HookFormat } from '../adapters/types';
import { Credential } from '../runtime';
import { PATHS, ensureRoot, isWindows } from '../util/paths';
import { logger } from '../util/log';

const log = logger('install');
const MARKER = 'agent-adapter'; // identifies hook entries we own

// ── agent detection ────────────────────────────────────────────
export function detectReport(): { kind: string; installed: boolean; wired: boolean }[] {
  return ALL_ADAPTERS.map((a) => ({
    kind: a.kind,
    installed: dirExists(a.detectDir),
    wired: Boolean(a.hooks),
  }));
}

// ── hook invocation string ─────────────────────────────────────
/** Command prefix the agent runs for each hook. Works for a packaged binary
 *  (`<bin> hook …`) or dev (`node <cli.js> hook …`). */
function hookInvocation(): string {
  if (process.env.AGENT_ADAPTER_BIN) return `${q(process.env.AGENT_ADAPTER_BIN)} hook`;
  const exec = process.execPath;
  if (path.basename(exec).includes('agent-adapter')) return `${q(exec)} hook`;
  const cli = path.resolve(__dirname, '..', 'cli.js');
  return `${q(exec)} ${q(cli)} hook`;
}

function startArgs(): string[] {
  if (process.env.AGENT_ADAPTER_BIN) return [process.env.AGENT_ADAPTER_BIN, 'start'];
  const exec = process.execPath;
  if (path.basename(exec).includes('agent-adapter')) return [exec, 'start'];
  return [exec, path.resolve(__dirname, '..', 'cli.js'), 'start'];
}

// ── install / uninstall hooks ──────────────────────────────────
export function installHooks(): string[] {
  ensureRoot();
  const inv = hookInvocation();
  const wired: string[] = [];
  for (const a of detected()) {
    if (!a.hooks) continue;
    try {
      mergeHooks(a, inv);
      wired.push(a.kind);
      log.info(`wired hooks: ${a.kind} → ${a.hooks.configPath}`);
    } catch (e) {
      log.error(`failed to wire ${a.kind}`, String(e));
    }
  }
  return wired;
}

export function uninstallHooks(): void {
  for (const a of ALL_ADAPTERS) {
    if (!a.hooks) continue;
    try { stripHooks(a.hooks.configPath, a.hooks.format); } catch { /* noop */ }
  }
}

function mergeHooks(a: AdapterDescriptor, inv: string): void {
  const recipe = a.hooks!;
  const cfg = readJson(recipe.configPath);
  if (recipe.format === 'cursor' && typeof cfg.version !== 'number') cfg.version = 1;
  const hooks = (cfg.hooks ??= {}) as Record<string, unknown>;

  for (const [nativeEvent, canonical] of Object.entries(recipe.events)) {
    const reply = neutralReply(a.kind, nativeEvent);
    const cmd = `${inv} --kind ${a.kind} --event ${canonical}` + (reply ? ` --reply ${reply}` : '');
    const list = ownedReset(asArray(hooks[nativeEvent]), recipe.format);
    list.push(entryFor(recipe.format, cmd));
    hooks[nativeEvent] = list;
  }
  writeJson(recipe.configPath, cfg);
}

function stripHooks(configPath: string, format: HookFormat): void {
  if (!fs.existsSync(configPath)) return;
  const cfg = readJson(configPath);
  const hooks = cfg.hooks as Record<string, unknown> | undefined;
  if (!hooks) return;
  for (const key of Object.keys(hooks)) {
    const cleaned = ownedReset(asArray(hooks[key]), format);
    if (cleaned.length) hooks[key] = cleaned;
    else delete hooks[key];
  }
  writeJson(configPath, cfg);
  log.info(`removed hooks from ${configPath}`);
}

/** Drop entries we previously installed (idempotent re-install / clean uninstall). */
function ownedReset(list: unknown[], format: HookFormat): unknown[] {
  return list.filter((entry) => !JSON.stringify(entry).includes(MARKER));
}

function entryFor(format: HookFormat, command: string): unknown {
  if (format === 'claude') return { hooks: [{ type: 'command', command }] };
  return { command }; // codex + cursor: command hooks
}

/** Cursor needs a valid neutral stdout per event type; others say nothing. */
function neutralReply(kind: string, nativeEvent: string): string | null {
  if (kind !== 'cursor') return null;
  if (nativeEvent === 'beforeSubmitPrompt') return 'continue';
  if (/^before(Shell|MCP|ReadFile)/.test(nativeEvent)) return 'permission';
  return 'none';
}

// ── daemon registration (best-effort) ──────────────────────────
export function registerDaemon(): void {
  try {
    if (process.platform === 'darwin') registerLaunchd();
    else if (process.platform === 'linux') registerSystemd();
    else if (isWindows) registerSchtasks();
  } catch (e) {
    log.warn('daemon registration failed (run `agent-adapter start` manually)', String(e));
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

// ── credentials ────────────────────────────────────────────────
export function saveCredential(token: string): void {
  ensureRoot();
  fs.writeFileSync(PATHS.credentials, JSON.stringify({ token }, null, 2), { mode: 0o600 });
}
export function loadCredential(): Credential | undefined {
  try {
    const { token } = JSON.parse(fs.readFileSync(PATHS.credentials, 'utf8'));
    if (typeof token === 'string') return { token };
  } catch { /* none */ }
  return undefined;
}

// ── small fs/string helpers ────────────────────────────────────
function readJson(p: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function dirExists(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function q(s: string): string { return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s; }
function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
