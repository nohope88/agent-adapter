import os from 'os';
import path from 'path';
import fs from 'fs';

/** Everything the adapter owns lives under ~/.agent-adapter (overridable for tests). */
export const HOME = os.homedir();
export const ROOT = process.env.AGENT_ADAPTER_HOME || path.join(HOME, '.agent-adapter');

export const PATHS = {
  root: ROOT,
  credentials: path.join(ROOT, 'credentials.json'),
  pidfile: path.join(ROOT, 'adapter.pid'),
  /** Unix domain socket the hooks post events to. */
  ingestSock: path.join(ROOT, 'ingest.sock'),
  /** Windows can't use a unix socket — hooks use TCP loopback instead. */
  ingestTcpPort: Number(process.env.AGENT_ADAPTER_INGEST_PORT || 19284),
  /** Preferred local control-API port (CLI ⇄ hub). The hub falls back to a free
   *  port if this is taken and publishes the actual one to `controlPortFile`. */
  controlPort: Number(process.env.AGENT_ADAPTER_CONTROL_PORT || 7788),
  /** Where a running hub records the control port it actually bound. */
  controlPortFile: path.join(ROOT, 'control.port'),
  log: path.join(ROOT, 'adapter.log'),
};

export const isWindows = process.platform === 'win32';

export function ensureRoot(): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
}

/** Client-side control-port resolution: published file → env/default. */
export function readControlPort(): number {
  try {
    const n = Number(fs.readFileSync(PATHS.controlPortFile, 'utf8').trim());
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* no running hub / unreadable → fall back */ }
  return PATHS.controlPort;
}

/** Hub-side: publish the control port it actually bound, for out-of-process clients. */
export function writeControlPort(port: number): void {
  ensureRoot();
  fs.writeFileSync(PATHS.controlPortFile, String(port), { mode: 0o600 });
}

/** Hub-side: remove the published port on shutdown. */
export function clearControlPort(): void {
  try { fs.unlinkSync(PATHS.controlPortFile); } catch { /* already gone */ }
}

/** Per-agent state dirs we probe to decide which adapters to enable. */
export const AGENT_DIRS = {
  'claude-code': path.join(HOME, '.claude'),
  codex: path.join(HOME, '.codex'),
  cursor: path.join(HOME, '.cursor'),
  gemini: path.join(HOME, '.gemini'),
  openclaw: path.join(HOME, '.openclaw'),
  hermes: path.join(HOME, '.hermes'),
} as const;

export function hostId(): string {
  return os.hostname().split('.')[0];
}
