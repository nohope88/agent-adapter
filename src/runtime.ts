import {
  ACAP_VERSION, AgentStatus, Ack, Command, Hello, Register, SCHEMA_V,
  Envelope, envelope, toWireStatus,
} from './protocol';
import { AdapterDescriptor } from './adapters/types';
import { register as restRegister } from './commanderClient';
import { hostId } from './util/paths';
import { logger } from './util/log';

const log = logger('uplink');

/** Credential the adapter holds: the tenant API key (cmdr_ak_…). The Commander owns auth. */
export interface Credential {
  token: string;
}

export interface RuntimeOpts {
  commanderUrl?: string;          // https base
  credential?: Credential;        // tenant key; absent ⇒ uplink disabled (e.g. tests)
  adapters: AdapterDescriptor[];  // one connection per detected kind
  /** Full current roster, pushed on every (re)connect (ACAP carries no retained state). */
  snapshotProvider: () => AgentStatus[];
  /** Handle a command from the Commander; return the Ack to send back. */
  onCommand: (cmd: Command) => Promise<Ack>;
}

const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 30_000;
const FORBIDDEN_BACKOFF = 60_000;   // 4403: back off harder, surface to operator
const DEFAULT_HEARTBEAT_SEC = 30;
const DEFAULT_MIN_STATUS_MS = 250;
const CMD_TTL_MS = 5 * 60_000;      // dedup window (spec §9.3)
const CMD_MAX = 1000;

/**
 * One Commander connection for one agent kind. Implements the full ACAP lifecycle
 * (spec §6): register (REST) → WS upgrade (subprotocol bearer) → await hello →
 * stream status / receive cmd / heartbeat → reconnect with backoff. Each reconnect
 * re-registers, so a 4401/expiry is handled by construction (no stale token reuse).
 */
class KindConn {
  // Node ≥22 exposes a global WebSocket; its types aren't in the ES lib, so the
  // handle stays loosely typed rather than pulling in the DOM lib.
  private ws: any = null;
  private connected = false;     // socket open
  private helloReceived = false; // may send status only after hello (§6.3)
  private closing = false;
  private backoff = BACKOFF_BASE;
  private wsToken: string | undefined;
  private heartbeatSec = DEFAULT_HEARTBEAT_SEC;
  private minStatusMs = DEFAULT_MIN_STATUS_MS;

  private buffer = new Map<string, AgentStatus>();   // coalesced while not ready
  private pending = new Map<string, AgentStatus>();  // coalesced within minStatusMs
  private lastSentAt = new Map<string, number>();
  private seenCmds = new Map<string, number>();      // cmdId → expiresAt (dedup)
  private sessionRegistered = new Set<string>();     // session agentIds registered on this connection (spec §7)
  private sessionRegistering = new Set<string>();    // session registers in flight
  private awaitingReg = new Map<string, AgentStatus>(); // newest snapshot to emit once its register lands

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private commanderUrl: string,
    private tenantKey: string,
    private adapter: AdapterDescriptor,
    private opts: RuntimeOpts,
  ) {}

  get kind(): string { return this.adapter.kind; }

  start(): void { void this.connect(); }

  /** Emit a status snapshot up. Coalesces by agentId while not ready, then throttles to minStatusMs. */
  sendStatus(s: AgentStatus): void {
    if (!this.connected || !this.helloReceived || !this.ws) {
      this.buffer.set(s.agentId, s);
      return;
    }
    this.maybeSend(s);
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.clearTimers();
    try { this.ws?.close(1000); } catch { /* noop */ }
    this.ws = null;
  }

  // ── connection lifecycle ─────────────────────────────────────
  private async connect(): Promise<void> {
    if (this.closing) return;
    // The per-kind connection holder; session agentIds are registered lazily (§7).
    const reg: Register = this.regBody(`${this.adapter.kind}:${hostId()}:adapter`);
    let wsUrl: string;
    try {
      const res = await restRegister(this.commanderUrl, this.tenantKey, reg);
      this.wsToken = res.wsToken;
      wsUrl = res.wsUrl;
      if (res.heartbeatSec) this.heartbeatSec = res.heartbeatSec;
      const ttl = (res.expiresInSec ?? 0) * 1000;
      if (ttl > 0) this.armExpiry(ttl * 0.8);   // re-register before the token expires (§6.1)
    } catch (e) {
      log.warn(`register ${this.adapter.kind} failed`, String(e));
      this.scheduleReconnect();
      return;
    }
    if (this.closing) return;
    this.openWs(wsUrl);
  }

  private openWs(wsUrl: string): void {
    const WSImpl: any = (globalThis as any).WebSocket;
    if (!WSImpl) { log.error('global WebSocket missing — need Node >= 22'); this.scheduleReconnect(); return; }
    log.info(`connecting ${this.adapter.kind} → ${wsUrl}`);
    let ws: any;
    try {
      // Subprotocol bearer (spec §4.3 option b) — works with the standard WebSocket
      // API, which can't set request headers. Never log the wsToken.
      ws = new WSImpl(wsUrl, [`acap.v1.bearer.${this.wsToken}`]);
    } catch (e) {
      log.error('ws construct failed', String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => { this.connected = true; });
    ws.addEventListener('message', (ev: any) => this.onMessage(ev));
    ws.addEventListener('close', (ev: any) => this.onClose(ev));
    ws.addEventListener('error', () => log.warn('uplink error'));
  }

  private onMessage(ev: any): void {
    let env: Envelope;
    try { env = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as Envelope; }
    catch { return; }
    if (!env || env.v !== SCHEMA_V) return;          // ignore unknown wire version (§5)
    switch (env.type) {
      case 'hello': return this.onHello(env.data as Hello);
      case 'ping': { this.send(envelope('pong', {}, env.id)); this.armWatchdog(); return; }
      case 'cmd': return void this.onCmd(env);
      default: return;                                // ignore unknown/unused types (§5)
    }
  }

  private onHello(data: Hello): void {
    this.helloReceived = true;
    this.backoff = BACKOFF_BASE;                      // healthy connection: reset backoff
    if (data?.heartbeatSec) this.heartbeatSec = data.heartbeatSec;
    if (typeof data?.minStatusIntervalMs === 'number') this.minStatusMs = data.minStatusIntervalMs;
    log.info(`uplink ready: ${this.adapter.kind}`);
    this.armWatchdog();
    this.flush();
  }

  private async onCmd(env: Envelope): Promise<void> {
    const data = (env.data || {}) as Partial<Command>;
    const cmdId = data.cmdId || '';
    const agentId = env.id || data.agentId || '';
    // At-least-once delivery → dedupe on cmdId (spec §9.3, a MUST).
    if (cmdId && !this.rememberCmd(cmdId)) {
      this.send(envelope('ack', { cmdId, status: 'duplicate' } as Ack, agentId));
      return;
    }
    const cmd: Command = {
      cmdId, intent: data.intent as Command['intent'], agentId,
      source: data.source, prompt: data.prompt, answer: data.answer, mode: data.mode,
    };
    let ack: Ack;
    try { ack = await this.opts.onCommand(cmd); }
    catch (e) { ack = { cmdId, status: 'rejected', reason: 'agent-error', detail: String(e) }; }
    this.send(envelope('ack', ack, agentId));
  }

  private onClose(ev: any): void {
    this.connected = false;
    this.helloReceived = false;
    this.ws = null;
    this.sessionRegistered.clear();
    this.sessionRegistering.clear();
    this.awaitingReg.clear();
    this.clearTransientTimers();
    if (this.closing) return;
    const code = ev?.code;
    if (code === 4403) {
      log.error(`${this.adapter.kind} forbidden (4403) — check tenant quota/policy`);
      this.backoff = FORBIDDEN_BACKOFF;
    } else if (code === 4429) {
      this.minStatusMs = Math.max(this.minStatusMs * 2, DEFAULT_MIN_STATUS_MS);
      log.warn(`${this.adapter.kind} rate limited (4429) — slowing to ${this.minStatusMs}ms`);
    }
    // 4401 (token expired/revoked), 4408 (heartbeat), 1011, 1000, etc. → reconnect,
    // which re-registers for a fresh token (§6.2 — never retry the same token).
    this.scheduleReconnect();
  }

  // ── status sending ───────────────────────────────────────────
  private maybeSend(s: AgentStatus): void {
    const now = Date.now();
    const since = now - (this.lastSentAt.get(s.agentId) ?? 0);
    if (this.minStatusMs <= 0 || since >= this.minStatusMs) {
      this.emitStatus(s);
    } else {
      this.pending.set(s.agentId, s);                // coalesce; trailing flush below
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.drainPending(), Math.max(this.minStatusMs - since, 0));
        this.flushTimer.unref?.();
      }
    }
  }

  private drainPending(): void {
    this.flushTimer = null;
    if (!this.connected || !this.helloReceived) return;
    for (const s of this.pending.values()) this.emitStatus(s);
    this.pending.clear();
  }

  private emitStatus(s: AgentStatus): void {
    if (!this.sessionRegistered.has(s.agentId)) { this.registerSession(s); return; }
    this.lastSentAt.set(s.agentId, Date.now());
    this.send(envelope('status', toWireStatus(s), s.agentId));
  }

  /** The register body for one agentId at this kind's declared capabilities. */
  private regBody(agentId: string): Register {
    return {
      v: SCHEMA_V, acap: ACAP_VERSION, kind: this.adapter.kind, agentId,
      level: this.adapter.level, capabilities: this.adapter.capabilities, provides: this.adapter.provides,
    };
  }

  /**
   * Per-session lazy registration (spec §7 / register-granularity): the Commander
   * silently drops status for an agentId it never saw a register for, so register
   * each session once — over REST — before streaming it, reusing this kind's WS.
   * Concurrent statuses for the same id coalesce to the newest, emitted once the
   * register lands; if the socket dropped meanwhile, it re-registers on reconnect.
   */
  private registerSession(s: AgentStatus): void {
    this.awaitingReg.set(s.agentId, s);
    if (this.sessionRegistering.has(s.agentId)) return;
    this.sessionRegistering.add(s.agentId);
    restRegister(this.commanderUrl, this.tenantKey, this.regBody(s.agentId))
      .then(() => {
        this.sessionRegistering.delete(s.agentId);
        if (!this.connected || !this.helloReceived) return; // dropped mid-register → re-register on reconnect
        this.sessionRegistered.add(s.agentId);
        const latest = this.awaitingReg.get(s.agentId);
        this.awaitingReg.delete(s.agentId);
        if (latest) this.emitStatus(latest);
      })
      .catch((e) => {
        this.sessionRegistering.delete(s.agentId);
        this.awaitingReg.delete(s.agentId);
        log.warn(`session register ${s.agentId} failed`, String(e));
      });
  }

  /** On hello, push the full roster for this kind (resync), then drain the offline buffer. */
  private flush(): void {
    for (const s of this.opts.snapshotProvider()) if (s.kind === this.adapter.kind) this.maybeSend(s);
    for (const s of this.buffer.values()) this.maybeSend(s);
    this.buffer.clear();
  }

  // ── dedup ────────────────────────────────────────────────────
  private rememberCmd(id: string): boolean {
    const now = Date.now();
    const exp = this.seenCmds.get(id);
    if (exp && exp > now) return false;               // already processed
    this.seenCmds.set(id, now + CMD_TTL_MS);
    if (this.seenCmds.size > CMD_MAX) {
      const oldest = this.seenCmds.keys().next().value;
      if (oldest !== undefined) this.seenCmds.delete(oldest);
    }
    return true;
  }

  // ── timers ───────────────────────────────────────────────────
  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const delay = Math.max(250, pseudoRandom() * Math.min(this.backoff, BACKOFF_CAP)); // full jitter, no hot-loop
    log.info(`reconnect ${this.adapter.kind} in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
    this.reconnectTimer.unref?.();
    this.backoff = Math.min(this.backoff * 2, BACKOFF_CAP);
  }

  private armWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    // No ping for 2×heartbeatSec ⇒ treat the socket as dead and reconnect (§6.4).
    this.watchdog = setTimeout(() => { try { this.ws?.close(4408); } catch { /* noop */ } }, this.heartbeatSec * 2000);
    this.watchdog.unref?.();
  }

  private armExpiry(ms: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => { try { this.ws?.close(4401); } catch { /* noop */ } }, ms);
    this.expiryTimer.unref?.();
  }

  private clearTransientTimers(): void {
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
    if (this.expiryTimer) { clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  }

  private clearTimers(): void {
    this.clearTransientTimers();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private send(env: Envelope): void {
    try { this.ws?.send(JSON.stringify(env)); } catch (e) { log.warn('send failed', String(e)); }
  }
}

/**
 * ACAP client. With no Commander URL / no credential it's a no-op sink (the hub
 * stays functional on the machine — used by tests). Otherwise it holds one
 * KindConn per detected kind and fans status out to the matching connection.
 */
export class Uplink {
  private conns: KindConn[] = [];

  constructor(private opts: RuntimeOpts) {}

  start(): void {
    if (!this.opts.commanderUrl || !this.opts.credential) {
      log.info('no credential — Commander uplink disabled');
      return;
    }
    for (const a of this.opts.adapters) {
      const c = new KindConn(this.opts.commanderUrl, this.opts.credential.token, a, this.opts);
      this.conns.push(c);
      c.start();
    }
  }

  sendStatus(s: AgentStatus): void {
    for (const c of this.conns) if (c.kind === s.kind) c.sendStatus(s);
  }

  async stop(): Promise<void> {
    for (const c of this.conns) await c.stop();
    this.conns = [];
  }
}

/** Deterministic-ish jitter without Math.random (kept simple, not crypto). */
function pseudoRandom(): number {
  return (Date.now() % 1000) / 1000;
}
