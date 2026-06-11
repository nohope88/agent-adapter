import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { AdapterDescriptor } from '../types';
import { CanonicalEvent, HookEvent } from '../../protocol';
import { AGENT_DIRS } from '../../util/paths';

const SESSIONS_DIR = path.join(AGENT_DIRS.codex, 'sessions');
const POLL_MS = 2000;
const SHOW_MS = 30 * 60_000;       // only surface sessions whose rollout changed in this window
const WORKING_STALE_MS = 120_000;  // a "working" turn with no writes for >2min → treat as idle (safety)

/** Status we derive from a Codex rollout file's content. */
export type CodexStatus = 'working' | 'idle' | 'waiting';
export interface CodexDerived {
  sessionId: string;
  cwd?: string;
  title?: string;
  model?: string;
  status: CodexStatus;
  waitingText?: string;
  lastResponse?: string;
}

/**
 * Codex (codex_cli_rs) has no hook system that runs our script — it appends a
 * per-session rollout JSONL under ~/.codex/sessions/YYYY/MM/DD/. We surface the
 * conversations a live Codex process currently holds open (via lsof) and derive
 * working/idle/waiting from each one's event stream. When a conversation's file
 * is released we end it promptly. Verified against Codex CLI 0.38.0. Where lsof
 * isn't available (e.g. Windows) we fall back to a recency window.
 */
const codex: AdapterDescriptor = {
  kind: 'codex',
  level: 'L2',
  capabilities: ['prompt', 'answer', 'interrupt'],
  provides: ['status', 'model'],
  inject: { channel: 'pty', hookReturn: true },
  detectDir: AGENT_DIRS.codex,
  poll: (emit) => {
    const tracked = new Map<string, { status: CodexStatus; id: string }>(); // rollout file → state
    const tick = () => {
      const now = Date.now();
      const files = openRollouts() ?? timeWindowRollouts(now); // live conversations, else recency window
      const seen = new Set<string>();
      for (const { file, mtime } of files) {
        let text: string;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const d = deriveFromRollout(text, mtime, now, sessionIdFromName(path.basename(file)));
        if (!d) continue;
        seen.add(file);
        const prev = tracked.get(file);
        if (!prev) emit(metaEvent(d, 'SessionStart'));
        if (!prev || prev.status !== d.status) emit(statusEvent(d));
        tracked.set(file, { status: d.status, id: d.sessionId });
      }
      // a conversation whose file is no longer open → it closed; end it now.
      for (const [file, t] of [...tracked]) {
        if (!seen.has(file)) {
          emit({ v: 1, kind: 'codex', event: 'SessionEnd', sessionId: t.id });
          tracked.delete(file);
        }
      }
    };
    const timer = setInterval(tick, POLL_MS);
    if (timer.unref) timer.unref();
    tick();
    return () => clearInterval(timer);
  },
};

/**
 * Rollout files a live process currently holds open (`lsof -c codex`) — the
 * authoritative "this conversation is running" signal. Returns null when lsof
 * is unavailable so the caller falls back to the recency window.
 */
function openRollouts(): { file: string; mtime: number }[] | null {
  const r = spawnSync('lsof', ['-nP', '-F', 'n', '-c', 'codex'], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 8 << 20,
    // Guarantee lsof resolves even under a minimal daemon PATH (launchd/systemd
    // often omit /usr/sbin, where lsof lives).
    env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/sbin:/usr/bin:/bin` },
  });
  if (r.error || typeof r.stdout !== 'string') return null; // lsof missing → fall back
  const out: { file: string; mtime: number }[] = [];
  const seen = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    if (line.charCodeAt(0) !== 110) continue; // lsof -F: file-name fields start with 'n'
    const p = line.slice(1);
    if (seen.has(p) || !p.startsWith(SESSIONS_DIR + path.sep) || !/rollout-.*\.jsonl$/.test(p)) continue;
    let mtime: number;
    try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
    seen.add(p);
    out.push({ file: p, mtime });
  }
  return out;
}

/** Fallback: rollout files (recursively) written within SHOW_MS, newest first. */
function timeWindowRollouts(now: number): { file: string; mtime: number }[] {
  let entries: string[];
  try { entries = fs.readdirSync(SESSIONS_DIR, { recursive: true }) as string[]; }
  catch { return []; }
  const out: { file: string; mtime: number }[] = [];
  for (const rel of entries) {
    const base = path.basename(rel);
    if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) continue;
    const file = path.join(SESSIONS_DIR, rel);
    let mtime: number;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    if (now - mtime <= SHOW_MS) out.push({ file, mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Pure status derivation from a rollout file's text. Exported for tests.
 * Folds the JSONL event stream and decides the session's current state by the
 * relative recency of the last user turn, agent reply, and approval request.
 */
export function deriveFromRollout(
  text: string, mtimeMs: number, nowMs: number, fallbackId: string,
): CodexDerived | null {
  let sessionId = fallbackId;
  let cwd: string | undefined;
  let model: string | undefined;
  let title: string | undefined;
  let lastUserTs = 0, lastAgentTs = 0, lastApprovalTs = 0, lastResolveTs = 0;
  let waitingText: string | undefined;
  let lastResponse: string | undefined;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try { o = JSON.parse(line); } catch { continue; } // tolerate a half-written tail line
    const ts = tsMs(o.timestamp);
    const p = (o.payload || {}) as Record<string, unknown>;
    if (o.type === 'session_meta') {
      if (typeof p.id === 'string') sessionId = p.id;
      if (typeof p.cwd === 'string') cwd = p.cwd;
    } else if (o.type === 'turn_context') {
      if (typeof p.cwd === 'string') cwd = p.cwd;
      if (typeof p.model === 'string') model = p.model;
    } else if (o.type === 'event_msg') {
      const pt = typeof p.type === 'string' ? p.type : '';
      if (pt === 'user_message') {
        lastUserTs = Math.max(lastUserTs, ts);
        if (!title && typeof p.message === 'string') title = p.message;
      } else if (pt === 'agent_message') {
        lastAgentTs = Math.max(lastAgentTs, ts);
        if (typeof p.message === 'string') lastResponse = p.message;
      } else if (/approval/i.test(pt)) {
        lastApprovalTs = Math.max(lastApprovalTs, ts);
        waitingText = approvalText(p);
      }
    } else if (o.type === 'response_item' && p.type === 'function_call_output') {
      lastResolveTs = Math.max(lastResolveTs, ts); // a tool ran → any pending approval is resolved
    }
  }
  if (!sessionId) return null;

  let status: CodexStatus;
  const approvalPending = lastApprovalTs > 0 &&
    lastApprovalTs >= lastResolveTs && lastApprovalTs >= lastAgentTs && lastApprovalTs >= lastUserTs;
  if (approvalPending) {
    status = 'waiting';
  } else if (lastUserTs > lastAgentTs) {
    status = nowMs - mtimeMs > WORKING_STALE_MS ? 'idle' : 'working';
  } else {
    status = 'idle';
  }
  return {
    sessionId,
    cwd,
    title: title?.slice(0, 80),
    model,
    status,
    waitingText,
    lastResponse: lastResponse?.slice(0, 200),
  };
}

function metaEvent(d: CodexDerived, event: CanonicalEvent): HookEvent {
  return { v: 1, kind: 'codex', event, sessionId: d.sessionId, cwd: d.cwd, title: d.title, model: d.model };
}

function statusEvent(d: CodexDerived): HookEvent {
  if (d.status === 'working') return metaEvent(d, 'UserPromptSubmit');
  if (d.status === 'waiting') {
    return { ...metaEvent(d, 'PermissionRequest'),
      message: d.waitingText || 'Codex is requesting approval', options: ['yes', 'no'] };
  }
  return { ...metaEvent(d, 'Stop'), lastResponse: d.lastResponse };
}

/** `rollout-<ts>-<uuid>.jsonl` → the trailing uuid. */
function sessionIdFromName(name: string): string {
  const m = name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : name.replace(/\.jsonl$/, '');
}

function approvalText(p: Record<string, unknown>): string {
  const cmd = (p.command ?? (p.call as Record<string, unknown>)?.command ?? p.parsed_cmd) as unknown;
  if (Array.isArray(cmd)) return 'Run: ' + cmd.join(' ');
  if (typeof cmd === 'string') return 'Run: ' + cmd;
  if (typeof p.message === 'string') return p.message;
  return 'Codex is requesting approval';
}

function tsMs(iso: unknown): number {
  if (typeof iso !== 'string') return 0;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

export default codex;
