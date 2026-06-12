import { AgentStatus, HookEvent } from './protocol';
import { reduce, statusPriority } from './statemachine';
import { logger } from './util/log';

const log = logger('store');

/** Fields whose change is "visible" — emit upstream only when one of these moves.
 *  `updatedAt` is deliberately excluded (spec §8.6: it MUST NOT count as a change). */
const VISIBLE: (keyof AgentStatus)[] = [
  'status', 'title', 'cwd', 'model', 'mode', 'lastReply',
];

type Listener = (s: AgentStatus) => void;

/**
 * Holds one snapshot per session, applies events through the state machine,
 * throttles upstream emits to visible changes, and prunes stale sessions.
 */
export class SessionStore {
  private map = new Map<string, AgentStatus>();
  private lastEventAt = new Map<string, number>();
  private listeners = new Set<Listener>();
  private staleMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: { staleMs?: number } = {}) {
    this.staleMs = opts.staleMs ?? 30 * 60 * 1000; // 30 min with no events → ended
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Apply a hook event; emit upstream iff something visible changed. */
  apply(ev: HookEvent): AgentStatus | null {
    if (!ev.sessionId || !ev.kind) {
      log.warn('dropping event without sessionId/kind', ev.event);
      return null;
    }
    const prev = this.map.get(ev.sessionId);
    const next = reduce(prev, ev);
    this.map.set(next.sessionId, next);
    this.lastEventAt.set(next.sessionId, Date.now());

    if (!prev || visibleChange(prev, next)) {
      for (const l of this.listeners) l(next);
      return next;
    }
    return null;
  }

  get(sessionId: string): AgentStatus | undefined {
    return this.map.get(sessionId);
  }

  byAgentId(agentId: string): AgentStatus | undefined {
    for (const s of this.map.values()) if (s.agentId === agentId) return s;
    return undefined;
  }

  /** Full roster, waiting first, then by recency — matches the device sort. */
  roster(): AgentStatus[] {
    return [...this.map.values()].sort((a, b) => {
      const p = statusPriority(b.status) - statusPriority(a.status);
      return p !== 0 ? p : b.updatedAt - a.updatedAt;
    });
  }

  /** Background prune: sessions silent past staleMs are marked ended once, then dropped. */
  startPrune(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.prune(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stopPrune(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.map) {
      const last = this.lastEventAt.get(id) ?? 0;
      if (now - last > this.staleMs) {
        if (s.status !== 'ended') {
          const ended = { ...s, status: 'ended' as const, updatedAt: Date.now() };
          this.map.set(id, ended);
          for (const l of this.listeners) l(ended);
        } else {
          this.map.delete(id);
          this.lastEventAt.delete(id);
        }
      }
    }
  }
}

function visibleChange(a: AgentStatus, b: AgentStatus): boolean {
  for (const k of VISIBLE) if (a[k] !== b[k]) return true;
  // waiting banner appearing / disappearing / changing is always visible
  if (Boolean(a.waiting) !== Boolean(b.waiting)) return true;
  if (a.waiting && b.waiting && a.waiting.text !== b.waiting.text) return true;
  if (a.activeTools?.[0]?.name !== b.activeTools?.[0]?.name) return true;
  return false;
}
