import { AgentStatus, HookEvent, Status, Waiting } from './protocol';
import { hostId } from './util/paths';

/** Tools whose invocation means "the agent is asking you something" → waiting. */
const WAITING_TOOLS = new Set(['AskUserQuestion', 'AskQuestion', 'ask_user_question']);

/** Status priority when reconciling — higher wins for display/roster sort. */
const PRIORITY: Record<Status, number> = {
  waiting: 4, error: 3, working: 2, idle: 1, ended: 0,
};

export function agentIdOf(kind: string, sessionId: string): string {
  return `${kind}:${hostId()}:${sessionId}`;
}

/**
 * Folds one normalized HookEvent into the prior snapshot for that session.
 * Pure: returns the next snapshot. Caller decides whether it changed (see store).
 */
export function reduce(prev: AgentStatus | undefined, ev: HookEvent): AgentStatus {
  const sessionId = ev.sessionId;
  const kind = ev.kind;
  const next: AgentStatus = prev
    ? { ...prev }
    : {
        v: 1,
        agentId: agentIdOf(kind, sessionId),
        kind,
        host: hostId(),
        sessionId,
        ts: new Date().toISOString(),
        status: 'idle',
      };

  next.ts = new Date().toISOString();

  // ── oc-claw pitfall #2: source is upgrade-only, never downgrade.
  if (ev.source && shouldUpgradeSource(prev?.kind, ev.source)) next.kind = ev.source;

  // ── oc-claw pitfall #3: never overwrite a field with an empty incoming value.
  setIfPresent(next, 'cwd', ev.cwd);
  setIfPresent(next, 'title', ev.title);
  setIfPresent(next, 'model', ev.model);
  setIfPresent(next, 'mode', ev.mode);
  if (ev.context) next.context = ev.context;
  if (ev.cost) next.cost = ev.cost;

  switch (ev.event) {
    case 'SessionStart':
      next.status = 'idle';
      break;

    case 'UserPromptSubmit':
      next.status = 'working';
      clearWaiting(next);
      break;

    case 'PreToolUse': {
      const tool = ev.tool || 'tool';
      if (ev.tool && WAITING_TOOLS.has(ev.tool)) {
        next.status = 'waiting';
        next.waiting = waitingFromTool(ev);
      } else {
        next.status = 'working';
        next.activeTool = { name: tool, preview: previewOf(ev.toolInput), startedAt: next.ts };
        clearWaiting(next);
      }
      break;
    }

    case 'PostToolUse':
      next.status = 'working';
      next.activeTool = undefined;
      clearWaiting(next);
      break;

    case 'PermissionRequest':
      next.status = 'waiting';
      next.waiting = {
        kind: 'approval',
        text: ev.message || `Allow ${ev.tool || 'tool'}?`,
        options: ev.options && ev.options.length ? ev.options : ['yes', 'no'],
      };
      break;

    case 'Notification':
      // Claude Code fires this when blocked waiting on the user.
      next.status = 'waiting';
      next.waiting = {
        kind: 'input',
        text: ev.message || 'Agent needs your input',
        options: ev.options && ev.options.length ? ev.options : [],
      };
      break;

    case 'Stop':
      next.status = 'idle';
      next.activeTool = undefined;
      clearWaiting(next);
      if (ev.lastResponse) next.lastResponse = ev.lastResponse;
      break;

    case 'SessionEnd':
      next.status = 'ended';
      next.activeTool = undefined;
      clearWaiting(next);
      break;
  }

  return next;
}

export function statusPriority(s: Status): number {
  return PRIORITY[s] ?? 0;
}

function waitingFromTool(ev: HookEvent): Waiting {
  const input = ev.toolInput as { question?: string; options?: unknown } | undefined;
  let options: string[] = ev.options || [];
  if (!options.length && input && Array.isArray(input.options)) {
    options = (input.options as unknown[]).map((o) =>
      typeof o === 'string' ? o : String((o as { label?: string })?.label ?? o));
  }
  return {
    kind: 'select',
    text: (input && input.question) || ev.message || `${ev.tool} needs an answer`,
    options: options.length ? options : ['yes', 'no'],
  };
}

function clearWaiting(s: AgentStatus): void {
  s.waiting = undefined;
}

function previewOf(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return input.slice(0, 120);
  const o = input as Record<string, unknown>;
  const cand = o.command ?? o.file_path ?? o.path ?? o.description;
  if (typeof cand === 'string') return cand.slice(0, 120);
  try { return JSON.stringify(input).slice(0, 120); } catch { return undefined; }
}

function setIfPresent<K extends keyof AgentStatus>(s: AgentStatus, key: K, val: unknown): void {
  if (val !== undefined && val !== null && val !== '') {
    (s as unknown as Record<string, unknown>)[key as string] = val;
  }
}

/** Only let source move "up" the specificity ladder (cursor outranks cc). */
function shouldUpgradeSource(current: string | undefined, incoming: string): boolean {
  const rank: Record<string, number> = { 'claude-code': 1, cc: 1, cursor: 2 };
  if (!current) return true;
  return (rank[incoming] ?? 0) > (rank[current] ?? 0);
}
