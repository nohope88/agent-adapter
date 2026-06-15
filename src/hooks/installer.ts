import fs from 'fs';
import path from 'path';
import { ALL_ADAPTERS, detected } from '../adapters/registry';
import { registerPlatformDaemon, stopPlatformDaemon } from './installer-daemon';
import { AdapterDescriptor, HookFormat } from '../adapters/types';
import { Credential } from '../runtime';
import { PATHS, ensureRoot } from '../util/paths';
import { stableNode } from '../util/node';
import { logger } from '../util/log';

const log = logger('install');
const MARKER = 'agent-adapter'; // identifies hook entries we own

// ── agent detection ────────────────────────────────────────────
export function detectReport(): { kind: string; installed: boolean; wired: boolean }[] {
  return ALL_ADAPTERS.map((a) => ({
    kind: a.kind,
    installed: dirExists(a.detectDir),
    wired: Boolean(a.hooks || a.poll), // hooks OR a poller = actively monitored (not just process-baseline)
  }));
}

// ── hook invocation string ─────────────────────────────────────
/** Command prefix the agent runs for each hook. Works for a packaged binary
 *  (`<bin> hook …`) or dev (`node <cli.js> hook …`). */
function hookInvocation(): string {
  if (process.env.AGENT_ADAPTER_BIN) return `${q(process.env.AGENT_ADAPTER_BIN)} hook`;
  const exec = stableNode();
  if (path.basename(exec).includes('aca')) return `${q(exec)} hook`;
  const cli = path.resolve(__dirname, '..', 'cli.js');
  return `${q(exec)} ${q(cli)} hook`;
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

/** Re-scan installed agents and bring hooks into line: (re)wire every agent that
 *  is present (picking up newly-installed ones, healing stale/dup entries), and
 *  strip our hooks from any agent that is no longer present. Returns the wired
 *  kinds. An agent's config lives under its detect dir, so an uninstalled agent
 *  usually takes its hooks with it — the strip is best-effort cleanup. */
export function reconcileHooks(): string[] {
  ensureRoot();
  const inv = hookInvocation();
  const wired: string[] = [];
  for (const a of ALL_ADAPTERS) {
    if (!a.hooks) continue;
    if (dirExists(a.detectDir)) {
      try {
        mergeHooks(a, inv);
        wired.push(a.kind);
      } catch (e) {
        log.error(`failed to wire ${a.kind}`, String(e));
      }
    } else {
      stripHooks(a.hooks.configPath, a.hooks.format); // no-op if the config is already gone
    }
  }
  return wired;
}

function mergeHooks(a: AdapterDescriptor, inv: string): void {
  const recipe = a.hooks!;
  const cfg = readJson(recipe.configPath);
  if (recipe.format === 'cursor' && typeof cfg.version !== 'number') cfg.version = 1;
  const hooks = (cfg.hooks ??= {}) as Record<string, unknown>;

  for (const [nativeEvent, canonical] of Object.entries(recipe.events)) {
    const reply = neutralReply(a.kind, nativeEvent);
    const cmd = `${inv} --kind ${a.kind} --event ${canonical}` + (reply ? ` --reply ${reply}` : '') + ` # ${MARKER}`;
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
  registerPlatformDaemon();
}
export function stopDaemon() {
  return stopPlatformDaemon();
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
/** Remove the stored credential. Returns true if one was present. */
export function clearCredential(): boolean {
  try { fs.rmSync(PATHS.credentials); return true; } catch { return false; }
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
