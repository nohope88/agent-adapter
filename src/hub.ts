import http from 'http';
import { AgentStatus, Ack, Command, HookEvent, SCHEMA_V } from './protocol';
import { SessionStore } from './store';
import { BindingMap } from './binding';
import { Injector } from './injector';
import { IngestServer } from './ingest';
import { Uplink, Credential } from './runtime';
import { ProcessFallback } from './adapters/process-fallback';
import { detected, byKind, fallbackKinds } from './adapters/registry';
import { AdapterDescriptor } from './adapters/types';
import { acquireSingleInstance } from './util/lock';
import { PATHS, writeControlPort, clearControlPort } from './util/paths';
import { logger } from './util/log';

const log = logger('hub');

export interface HubOpts {
  commanderUrl?: string;
  credential?: Credential;
}

export class Hub {
  private store = new SessionStore();
  private binding = new BindingMap();
  private injector = new Injector(this.binding);
  private ingest: IngestServer;
  private uplink: Uplink;
  private fallback: ProcessFallback;
  private pollStops: (() => void)[] = [];
  private control: http.Server | null = null;
  private sse = new Set<http.ServerResponse>();
  private release: (() => void) | null = null;
  private adapters: AdapterDescriptor[];
  /** The control-API port actually bound (set on start; may differ from the preferred one). */
  controlPort = PATHS.controlPort;

  constructor(private opts: HubOpts) {
    this.adapters = detected();
    this.ingest = new IngestServer(
      (ev) => this.onEvent(ev),
      (ev) => this.injector.hookReturn.gateFor(ev),
    );
    this.uplink = new Uplink({
      commanderUrl: opts.commanderUrl,
      credential: opts.credential,
      adapters: this.adapters,
      snapshotProvider: () => this.store.roster(),
      onCommand: (cmd) => this.handleCommand(cmd),
    });
    this.fallback = new ProcessFallback(fallbackKinds(this.adapters), (ev) => this.onEvent(ev));
  }

  async start(): Promise<void> {
    this.release = acquireSingleInstance();

    this.store.onChange((s) => {
      this.uplink.sendStatus(s);
      this.broadcast(s);
    });
    this.store.startPrune();

    await this.ingest.start();
    this.uplink.start();
    this.fallback.start();

    for (const a of this.adapters) {
      if (a.poll) this.pollStops.push(a.poll((ev) => this.onEvent(ev)));
    }

    await this.startControl();

    log.info('hub up', {
      adapters: this.adapters.map((a) => a.kind),
      mode: this.opts.credential ? 'uplink' : 'standalone',
    });
  }

  async stop(): Promise<void> {
    this.store.stopPrune();
    this.fallback.stop();
    for (const stop of this.pollStops) try { stop(); } catch { /* noop */ }
    await this.ingest.stop();
    await this.uplink.stop();
    if (this.control) await new Promise<void>((r) => this.control!.close(() => r()));
    clearControlPort();
    this.release?.();
  }

  // ── pipeline ─────────────────────────────────────────────────
  private onEvent(ev: HookEvent): void {
    this.binding.learn(ev);
    this.store.apply(ev);
  }

  /** One command path shared by the uplink and the local control API. */
  async handleCommand(cmd: Command): Promise<Ack> {
    const kind = cmd.agentId.split(':')[0];
    const adapter = byKind(kind);
    if (!adapter) return ack(cmd, 'rejected', 'unsupported-intent', `unknown kind ${kind}`);
    if (!adapter.capabilities.includes(cmd.intent)) {
      return ack(cmd, 'rejected', 'unsupported-intent', `intent ${cmd.intent} not supported by ${kind}`);
    }
    return this.injector.dispatch(cmd, adapter.inject);
  }

  // ── local control API (CLI ⇄ hub) ────────────────────────────
  private startControl(): Promise<void> {
    const srv = http.createServer((req, res) => this.onControl(req, res));
    this.control = srv;
    return new Promise((resolve, reject) => {
      srv.once('listening', () => {
        // Past startup, a server-level error must be logged, never crash the hub.
        srv.removeAllListeners('error');
        srv.on('error', (e) => log.error('control server error', String(e)));
        const port = (srv.address() as { port: number }).port;
        this.controlPort = port;
        writeControlPort(port); // publish for out-of-process clients (CLI/web)
        log.info(`control api on http://127.0.0.1:${port}`);
        resolve();
      });
      srv.once('error', (e: NodeJS.ErrnoException) => {
        // Preferred port unavailable → let the OS pick a free one and publish it,
        // so `status`/`answer`/the dashboard still find the hub.
        log.warn(`control port ${PATHS.controlPort} unavailable (${e.code}) — binding a free port`);
        srv.once('error', reject); // a failure on the free-port retry is fatal
        srv.listen(0, '127.0.0.1');
      });
      srv.listen(PATHS.controlPort, '127.0.0.1');
    });
  }

  private onControl(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';
    if (req.method === 'GET' && url === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url === '/agents') return json(res, 200, this.store.roster());
    if (req.method === 'GET' && url === '/stream') return this.openSse(res);
    if (req.method === 'POST' && url === '/command') return this.postCommand(req, res);
    // Test affordance: inject a raw hook event locally.
    if (req.method === 'POST' && url === '/ingest') return this.postIngest(req, res);
    json(res, 404, { error: 'not found' });
  }

  private postCommand(req: http.IncomingMessage, res: http.ServerResponse): void {
    readBody(req).then(async (body) => {
      try {
        const b = JSON.parse(body) as Partial<Command>;
        if (!b.agentId || !b.intent) return json(res, 400, { error: 'agentId and intent required' });
        const cmd: Command = {
          v: SCHEMA_V, cmdId: b.cmdId || rid(), ts: new Date().toISOString(),
          agentId: b.agentId, source: b.source || 'cli', intent: b.intent,
          prompt: b.prompt, answer: b.answer ?? undefined, mode: b.mode ?? undefined,
        };
        json(res, 200, await this.handleCommand(cmd));
      } catch (e) { json(res, 400, { error: String(e) }); }
    });
  }

  private postIngest(req: http.IncomingMessage, res: http.ServerResponse): void {
    readBody(req).then((body) => {
      try { this.onEvent(JSON.parse(body) as HookEvent); json(res, 200, { ok: true }); }
      catch (e) { json(res, 400, { error: String(e) }); }
    });
  }

  private openSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    res.write(`event: roster\ndata: ${JSON.stringify(this.store.roster())}\n\n`);
    this.sse.add(res);
    res.on('close', () => this.sse.delete(res));
  }

  private broadcast(s: AgentStatus): void {
    const line = `event: status\ndata: ${JSON.stringify(s)}\n\n`;
    for (const res of this.sse) {
      try { res.write(line); } catch { this.sse.delete(res); }
    }
  }
}

function ack(cmd: Command, status: Ack['status'], reason?: string, detail?: string): Ack {
  return { v: SCHEMA_V, cmdId: cmd.cmdId, status, reason, detail };
}
function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(s);
}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b));
  });
}
function rid(): string {
  return Date.now().toString(36) + Math.floor(performance.now()).toString(36);
}
