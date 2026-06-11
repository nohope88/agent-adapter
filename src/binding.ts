import { HookEvent } from './protocol';

/**
 * Session → injection target. The hard sub-problem behind "react back":
 * which terminal/window/handle do we send "yes" into for THIS session?
 *
 * We learn targets from hook events (pid, tty, cwd, cursor port / native handle)
 * and never rely on Cursor's ephemeral pid (oc-claw pitfall #1).
 */
export interface InjectTarget {
  kind: string;
  sessionId: string;
  pid?: number;
  tty?: string;
  cwd?: string;
  /** Cursor: the localhost port its window-extension bound to. */
  cursorPort?: number;
  /** Cursor: stable per-window id; survives pid churn. */
  nativeHandle?: string;
  /** openclaw/hermes: native control endpoint to send commands to. */
  controlEndpoint?: string;
  /** tmux pane id if the session is known to run inside tmux. */
  tmuxPane?: string;
  updatedAt: number;
}

export class BindingMap {
  private bySession = new Map<string, InjectTarget>();

  learn(ev: HookEvent): void {
    const id = ev.sessionId;
    if (!id) return;
    const t: InjectTarget = this.bySession.get(id) || {
      kind: ev.kind, sessionId: id, updatedAt: 0,
    };
    // pid is meaningful for pty agents but NOT for cursor (ephemeral) — guard it.
    if (typeof ev.pid === 'number' && ev.kind !== 'cursor') t.pid = ev.pid;
    if (ev.cwd) t.cwd = ev.cwd;
    const handle = ev['nativeHandle'];
    if (typeof handle === 'string') t.nativeHandle = handle;
    const port = ev['cursorPort'];
    if (typeof port === 'number') t.cursorPort = port;
    const ctrl = ev['controlEndpoint'];
    if (typeof ctrl === 'string') t.controlEndpoint = ctrl;
    const pane = ev['tmuxPane'];
    if (typeof pane === 'string') t.tmuxPane = pane;
    t.kind = ev.kind;
    t.updatedAt = Date.now();
    this.bySession.set(id, t);
  }

  resolve(sessionId: string): InjectTarget | undefined {
    return this.bySession.get(sessionId);
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
