import net from 'net';
import fs from 'fs';
import { HookEvent } from './protocol';
import { PATHS, isWindows, ensureRoot, writeIngestPort, clearIngestPort } from './util/paths';
import { logger } from './util/log';

const log = logger('ingest');

/**
 * Local server the installed hook scripts connect to. One line of JSON in
 * (a HookEvent); optionally one line of JSON out (a gate decision, used by the
 * hook-return interact-back channel). Unix domain socket on POSIX, TCP loopback
 * on Windows (which has no unix sockets in the hook script's shell).
 *
 * The hook side always uses a short timeout and fails open, so if this server
 * is down the agent is never blocked (design: hooks are fire-and-forget).
 */
export class IngestServer {
  private server: net.Server | null = null;
  constructor(
    private onEvent: (ev: HookEvent) => void,
    /** Return a gate decision to write back to the hook, or null to let it proceed. */
    private gate?: (ev: HookEvent) => Record<string, unknown> | null,
  ) {}

  start(): Promise<void> {
    ensureRoot();
    this.server = net.createServer((sock) => this.handle(sock));
    this.server.on('error', (e) => log.error('server error', String(e)));

    return new Promise((resolve, reject) => {
      const onErr = (e: unknown) => reject(e);
      this.server!.once('error', onErr);
      const onListening = () => {
        this.server!.off('error', onErr);
        // Unix socket: lock it to the owner. (No-op on the Windows TCP path.)
        if (!isWindows) { try { fs.chmodSync(PATHS.ingestSock, 0o600); } catch { /* noop */ } }
        // Publish the bound endpoint so the hook script can find it. On the
        // Windows TCP path the port is ephemeral (0 → OS-assigned), so two
        // servers (e.g. concurrent test workers) never collide on a fixed port.
        const addr = this.server!.address();
        const port = addr && typeof addr === 'object' ? addr.port : PATHS.ingestTcpPort;
        writeIngestPort(port);
        log.info(isWindows ? `listening on tcp 127.0.0.1:${port}` : `listening on unix ${PATHS.ingestSock}`);
        resolve();
      };
      if (!isWindows) { try { if (fs.existsSync(PATHS.ingestSock)) fs.unlinkSync(PATHS.ingestSock); } catch { /* noop */ } }
      // Windows has no unix sockets in the hook's shell → TCP loopback (ephemeral
      // port unless pinned via env); POSIX → unix socket.
      const winPort = process.env.AGENT_ADAPTER_INGEST_PORT ? PATHS.ingestTcpPort : 0;
      const opts = isWindows ? { port: winPort, host: '127.0.0.1' } : { path: PATHS.ingestSock };
      this.server!.listen(opts, onListening);
    });
  }

  private handle(sock: net.Socket): void {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.dispatch(line, sock);
      }
    });
    sock.on('error', () => { /* hook side may hang up; ignore */ });
  }

  private dispatch(line: string, sock: net.Socket): void {
    let ev: HookEvent;
    try {
      ev = JSON.parse(line) as HookEvent;
    } catch {
      log.warn('bad json from hook', line.slice(0, 80));
      return;
    }
    // Treat hook payloads as untrusted: require the minimum shape.
    if (!ev || typeof ev.kind !== 'string' || typeof ev.event !== 'string') {
      log.warn('hook event missing kind/event');
      return;
    }
    try {
      const decision = this.gate ? this.gate(ev) : null;
      if (decision) {
        try { sock.write(JSON.stringify(decision) + '\n'); } catch { /* noop */ }
      }
    } catch (e) {
      log.error('gate threw', String(e));
    }
    try { this.onEvent(ev); } catch (e) { log.error('onEvent threw', String(e)); }
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    if (!isWindows) { try { fs.unlinkSync(PATHS.ingestSock); } catch { /* noop */ } }
    clearIngestPort();
    this.server = null;
  }
}
