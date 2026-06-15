import { execFile } from 'child_process';
import { HookEvent } from '../protocol';
import { isWindows } from '../util/paths';
import { logger } from '../util/log';

const log = logger('fallback');

/** Command-line substrings that identify each agent's process. */
const PATTERNS: Record<string, RegExp> = {
  'claude-code': /(^|\/)claude(\s|$)/i,
  codex: /(^|\/)codex(\s|$)/i,
  gemini: /(^|\/)gemini(\s|$)/i,
  openclaw: /openclaw/i,
  hermes: /hermes/i,
};

const BUSY_CPU = 8; // pcpu above this → "working", else "idle"

/**
 * Process-based baseline: for kinds that have no hooks/poller, detect the
 * running process and infer working/idle from CPU%. Guarantees every agent
 * shows *something* live. Hook-driven kinds override this with real state.
 */
export class ProcessFallback {
  private timer: NodeJS.Timeout | null = null;
  private alive = new Set<string>();

  constructor(
    private kinds: string[],
    private emit: (ev: HookEvent) => void,
  ) {}

  start(): void {
    if (!this.kinds.length || this.timer) return;
    this.timer = setInterval(() => this.scan(), 3000);
    if (this.timer.unref) this.timer.unref();
    this.scan();
  }
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async scan(): Promise<void> {
    let rows: { pid: number; cpu: number; cmd: string }[];
    try { rows = await listProcesses(); } catch (e) { log.debug('ps failed', String(e)); return; }

    const seenNow = new Set<string>();
    for (const row of rows) {
      for (const kind of this.kinds) {
        const pat = PATTERNS[kind];
        if (!pat || !pat.test(row.cmd)) continue;
        const sessionId = `pid-${row.pid}`;
        seenNow.add(sessionId);
        if (!this.alive.has(sessionId)) {
          this.alive.add(sessionId);
          this.emit({ v: 1, kind, event: 'SessionStart', sessionId, pid: row.pid,
            title: `${kind} (pid ${row.pid})` });
        }
        // Emit every scan, not just on change: the store throttles upstream to
        // visible changes but refreshes each session's liveness on every apply,
        // so a steadily-idle but still-running process never trips the store's
        // stale→ended prune. (Without this, an idle session emits one Stop and
        // then goes silent, and is falsely reported "ended" after staleMs.)
        const state = row.cpu >= BUSY_CPU ? 'working' : 'idle';
        this.emit({ v: 1, kind, event: state === 'working' ? 'UserPromptSubmit' : 'Stop',
          sessionId, pid: row.pid });
      }
    }
    // processes that vanished → end their sessions
    for (const sessionId of [...this.alive]) {
      if (!seenNow.has(sessionId)) {
        this.alive.delete(sessionId);
        const kind = guessKind(sessionId, this.kinds);
        this.emit({ v: 1, kind, event: 'SessionEnd', sessionId });
      }
    }
  }
}

function guessKind(_sessionId: string, kinds: string[]): string {
  return kinds[0] || 'unknown';
}

function listProcesses(): Promise<{ pid: number; cpu: number; cmd: string }[]> {
  if (isWindows) {
    // Windows: no easy pcpu via tasklist; report presence as idle baseline.
    return run('tasklist', ['/fo', 'csv', '/nh']).then((out) =>
      out.split('\n').map((l) => l.split('","')).filter((c) => c.length > 1).map((c) => ({
        pid: Number((c[1] || '').replace(/[^\d]/g, '')) || 0,
        cpu: 0,
        cmd: (c[0] || '').replace(/^"/, ''),
      })).filter((r) => r.pid));
  }
  return run('ps', ['-axo', 'pid=,pcpu=,args=']).then((out) =>
    out.split('\n').map((line) => {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), cpu: Number(m[2]), cmd: m[3] };
    }).filter((r): r is { pid: number; cpu: number; cmd: string } => r !== null));
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()));
  });
}
