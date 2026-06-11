import net from 'net';
import { HookEvent, CanonicalEvent } from './protocol';
import { PATHS, isWindows } from './util/paths';

/**
 * Runs as `agent-adapter hook --kind <k> --event <canon> [--reply <neutral>]`.
 * The installed agent hooks invoke this. It reads the agent's event JSON on
 * stdin, normalizes it, posts it to the ingest socket, and — for gate-class
 * events — briefly waits for a decision to echo on stdout (hook-return).
 *
 * It ALWAYS exits 0 and never blocks longer than the budget: if the hub is
 * down or slow the agent proceeds with the neutral default (fail-open).
 */
export async function runHook(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const kind = args.kind || 'unknown';
  const event = (args.event || 'Notification') as CanonicalEvent;
  const neutral = args.reply || 'none'; // none | continue | permission

  const raw = await readStdin();
  let payload: Record<string, unknown> = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { /* tolerate non-JSON */ }

  const ev = normalize(kind, event, payload);
  const gateClass = event === 'PreToolUse' || event === 'PermissionRequest';

  let decision: Record<string, unknown> | null = null;
  try {
    decision = await postEvent(ev, gateClass ? 800 : 150);
  } catch { /* fail-open */ }

  process.stdout.write(renderDecision(neutral, decision));
  process.exit(0);
}

function normalize(kind: string, event: CanonicalEvent, p: Record<string, unknown>): HookEvent {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);

  const ev: HookEvent = {
    v: 1,
    kind,
    event,
    sessionId: s('session_id') || s('sessionId') || s('conversation_id') || `${kind}-unknown`,
    ts: new Date().toISOString(),
    cwd: s('cwd') || firstRoot(p['workspaceRoots']),
    pid: n('pid'),
    model: s('model'),
    mode: s('permission_mode') || s('mode'),
    title: s('aiTitle') || s('title'),
    message: s('message'),
  };

  // tool + input (generic, then Cursor's event-specific shapes)
  ev.tool = s('tool_name') || s('tool');
  if (p['tool_input'] !== undefined) ev.toolInput = p['tool_input'];
  else if (p['toolInput'] !== undefined) ev.toolInput = p['toolInput'];
  if (kind === 'cursor') applyCursorShape(p, ev);

  if (event === 'Stop') ev.lastResponse = s('response') || s('last_response') || s('lastResponse');
  return ev;
}

function applyCursorShape(p: Record<string, unknown>, ev: HookEvent): void {
  if (typeof p['command'] === 'string') { ev.tool = 'Shell'; ev.toolInput = { command: p['command'] }; }
  else if (typeof p['file_path'] === 'string') { ev.tool = 'Edit'; ev.toolInput = { file_path: p['file_path'] }; }
  if (typeof p['nativeHandle'] === 'string') ev['nativeHandle'] = p['nativeHandle'];
  ev.source = 'cursor';
}

function renderDecision(neutral: string, decision: Record<string, unknown> | null): string {
  if (decision) {
    if (neutral === 'permission') return JSON.stringify({ permission: decision.permission ?? 'allow' });
    if (neutral === 'continue') return JSON.stringify({ continue: decision.continue ?? true });
    return JSON.stringify(decision);
  }
  if (neutral === 'permission') return JSON.stringify({ permission: 'allow' });
  if (neutral === 'continue') return JSON.stringify({ continue: true });
  return ''; // neutral: say nothing → agent proceeds normally
}

/** Send one event line; optionally read one reply line within `waitMs`. */
function postEvent(ev: HookEvent, waitMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const sock = isWindows
      ? net.connect(PATHS.ingestTcpPort, '127.0.0.1')
      : net.connect(PATHS.ingestSock);
    let buf = '';
    let settled = false;
    const done = (v: Record<string, unknown> | null) => {
      if (settled) return; settled = true; try { sock.end(); } catch { /* noop */ } resolve(v);
    };
    const budget = setTimeout(() => done(null), waitMs);
    if (budget.unref) budget.unref();

    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(ev) + '\n'));
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(budget);
        try { done(JSON.parse(buf.slice(0, nl))); } catch { done(null); }
      }
    });
    sock.on('error', (e) => { clearTimeout(budget); if (!settled) { settled = true; reject(e); } });
    sock.on('close', () => done(null));
  });
}

function firstRoot(v: unknown): string | undefined {
  return Array.isArray(v) && typeof v[0] === 'string' ? (v[0] as string) : undefined;
}
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 500).unref?.();
  });
}
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}
