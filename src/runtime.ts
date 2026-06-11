import {
  ACAP_VERSION, AgentStatus, Ack, Command, Register, Envelope, envelope, SCHEMA_V,
} from './protocol';
import { AdapterDescriptor } from './adapters/types';
import { logger } from './util/log';

const log = logger('uplink');

export interface Credential {
  token: string;
  /** Optional refresh hook — called when the server rejects/expires the token. */
  refresh?: () => Promise<string>;
}

export interface RuntimeOpts {
  commanderUrl?: string;          // wss://… ; absent ⇒ local mode
  local: boolean;
  credential?: Credential;
  adapters: AdapterDescriptor[];  // for the register handshake
  /** Full current roster, pushed on every (re)connect (replaces retained msgs). */
  snapshotProvider: () => AgentStatus[];
  /** Handle a command from the Commander; return the Ack to send back. */
  onCommand: (cmd: Command) => Promise<Ack>;
}

/**
 * ACAP client. In local mode it's a no-op sink (everything still works on the
 * machine). With a commanderUrl it holds one WSS uplink: registers, streams
 * status up, receives cmd down, sends ack — and survives drops via backoff,
 * token refresh, and offline coalescing (latest snapshot per agent).
 */
export class Uplink {
  // Node >=22 exposes a global WebSocket at runtime; its types aren't in the
  // ES lib, so we keep the handle loosely typed rather than pull in the DOM lib.
  private ws: any = null;
  private connected = false;
  private closing = false;
  private backoff = 1000;
  private readonly maxBackoff = 30_000;
  private buffer = new Map<string, AgentStatus>(); // coalesced while offline
  private token: string | undefined;

  constructor(private opts: RuntimeOpts) {
    this.token = opts.credential?.token;
  }

  start(): void {
    if (this.opts.local || !this.opts.commanderUrl) {
      log.info('local mode — no Commander uplink');
      return;
    }
    this.open();
  }

  /** Emit a status snapshot up. Coalesces by agentId while disconnected. */
  sendStatus(s: AgentStatus): void {
    if (this.opts.local || !this.opts.commanderUrl) return;
    if (this.connected && this.ws) {
      this.send(envelope('status', s, s.agentId));
    } else {
      this.buffer.set(s.agentId, s); // keep only the latest per agent
    }
  }

  async stop(): Promise<void> {
    this.closing = true;
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }

  // ── internals ───────────────────────────────────────────────
  private open(): void {
    const url = withToken(this.opts.commanderUrl!, this.token);
    log.info(`connecting ${redact(url)}`);
    const WSImpl: any = (globalThis as any).WebSocket;
    if (!WSImpl) { log.error('global WebSocket missing — need Node >= 22'); return; }
    let ws: any;
    try {
      ws = new WSImpl(url);
    } catch (e) {
      log.error('ws construct failed', String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.backoff = 1000;
      log.info('uplink open — registering');
      this.register();
      this.flush();
    });
    ws.addEventListener('message', (ev: any) => this.onMessage(ev));
    ws.addEventListener('close', (ev: any) => this.onClose(ev));
    ws.addEventListener('error', () => log.warn('uplink error'));
  }

  private register(): void {
    for (const a of this.opts.adapters) {
      const reg: Register = {
        v: SCHEMA_V, acap: ACAP_VERSION, kind: a.kind,
        agentId: a.kind, level: a.level,
        capabilities: a.capabilities, provides: a.provides,
      };
      this.send(envelope('register', reg, a.kind));
    }
  }

  /** On (re)connect push the full roster, then drain any coalesced buffer. */
  private flush(): void {
    for (const s of this.opts.snapshotProvider()) this.send(envelope('status', s, s.agentId));
    for (const s of this.buffer.values()) this.send(envelope('status', s, s.agentId));
    this.buffer.clear();
  }

  private async onMessage(ev: any): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as Envelope;
    } catch { return; }
    if (env.type === 'cmd') {
      const cmd = env.data as Command;
      let ack: Ack;
      try { ack = await this.opts.onCommand(cmd); }
      catch (e) { ack = { v: SCHEMA_V, cmdId: cmd.cmdId, status: 'rejected', detail: String(e) }; }
      this.send(envelope('ack', ack, cmd.agentId));
    }
  }

  private async onClose(ev: any): Promise<void> {
    this.connected = false;
    this.ws = null;
    if (this.closing) return;
    // 4401/1008 → auth problem: try to refresh the token before reconnecting.
    if ((ev.code === 4401 || ev.code === 1008) && this.opts.credential?.refresh) {
      try { this.token = await this.opts.credential.refresh(); log.info('token refreshed'); }
      catch (e) { log.warn('token refresh failed', String(e)); }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const jitter = Math.floor(this.backoff * 0.2 * pseudoRandom());
    const delay = Math.min(this.backoff, this.maxBackoff) + jitter;
    log.info(`reconnect in ${delay}ms`);
    const t = setTimeout(() => this.open(), delay);
    if (t.unref) t.unref();
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }

  private send(env: Envelope): void {
    try { this.ws?.send(JSON.stringify(env)); } catch (e) { log.warn('send failed', String(e)); }
  }
}

function withToken(url: string, token?: string): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
function redact(url: string): string {
  return url.replace(/token=[^&]+/, 'token=***');
}
/** Deterministic-ish jitter without Math.random (kept simple, not crypto). */
function pseudoRandom(): number {
  return (Date.now() % 1000) / 1000;
}
