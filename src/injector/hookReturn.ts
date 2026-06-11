import { HookEvent } from '../protocol';

/**
 * Hook-return channel: answer a permission/ask prompt via the hook's stdout
 * decision, with NO pty needed — the clean path when it's available.
 *
 * Flow: a `answer` command stages a decision for a session; the hook script,
 * for gate-class events, waits a bounded time and the ingest gate() hands it
 * the staged decision (then clears it). If nothing is staged in time, the hook
 * fails open (proceeds with the agent's own default) — never blocks the agent.
 */
type Decision = Record<string, unknown>;

const GATE_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);

export class HookReturnChannel {
  private staged = new Map<string, { decision: Decision; expires: number }>();

  /** Stage a decision for the next gate-class event of this session. */
  stage(sessionId: string, decision: Decision, ttlMs = 30_000): void {
    this.staged.set(sessionId, { decision, expires: Date.now() + ttlMs });
  }

  /** True if a decision is currently staged for this session. */
  has(sessionId: string): boolean {
    const e = this.staged.get(sessionId);
    if (!e) return false;
    if (Date.now() > e.expires) { this.staged.delete(sessionId); return false; }
    return true;
  }

  /** Called by ingest.gate(): return + clear a staged decision for a gate event. */
  gateFor(ev: HookEvent): Decision | null {
    if (!GATE_EVENTS.has(ev.event)) return null;
    const e = this.staged.get(ev.sessionId);
    if (!e || Date.now() > e.expires) { this.staged.delete(ev.sessionId); return null; }
    this.staged.delete(ev.sessionId);
    return e.decision;
  }
}

/** Map a canonical answer ("yes"/"allow"/option text) to a hook decision object. */
export function decisionFromAnswer(answer: string): Decision {
  const a = answer.trim().toLowerCase();
  const allow = a === 'yes' || a === 'y' || a === 'allow' || a === 'approve' || a === 'ok';
  // Superset of the shapes CC / Codex / Cursor hooks understand.
  return {
    permission: allow ? 'allow' : 'deny',
    decision: allow ? 'approve' : 'block',
    continue: allow,
    answer,
  };
}
