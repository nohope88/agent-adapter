import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── mock WebSocket ─────────────────────────────────────────────
type L = (ev?: any) => void;
class MockWS {
  static instances: MockWS[] = [];
  static sent: string[] = [];
  url: string; protocols: any;
  listeners: Record<string, L[]> = {};
  constructor(url: string, protocols?: any) { this.url = url; this.protocols = protocols; MockWS.instances.push(this); }
  addEventListener(t: string, fn: L) { (this.listeners[t] ??= []).push(fn); }
  send(d: string) { MockWS.sent.push(d); }
  close(code?: number) { this.emit('close', { code: code ?? 1000 }); }
  emit(t: string, ev?: any) { for (const fn of (this.listeners[t] || []).slice()) fn(ev); }
  open() { this.emit('open'); }
  msg(o: unknown) { this.emit('message', { data: JSON.stringify(o) }); }
  raw(d: string) { this.emit('message', { data: d }); }
  static last() { return MockWS.instances[MockWS.instances.length - 1]; }
  static reset() { MockWS.instances = []; MockWS.sent = []; }
}

const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
const okRegister = (over: Record<string, unknown> = {}) => async () =>
  ({ ok: true, json: async () => ({ v: 1, wsToken: 'tok', wsUrl: 'wss://cmd/v1/agent', expiresInSec: 900, heartbeatSec: 30, ...over }) });
const hello = (over: Record<string, unknown> = {}) =>
  ({ type: 'hello', v: 1, ts: '', id: 'x', data: { acap: '1.0', accepted: {}, heartbeatSec: 30, minStatusIntervalMs: 0, ...over } });
const ping = () => ({ type: 'ping', v: 1, ts: '', id: 'x', data: {} });
const cmd = (data: Record<string, unknown>, id = 'claude-code:h:s') => ({ type: 'cmd', v: 1, ts: '', id, data });
const st = (over: Record<string, unknown> = {}): any =>
  ({ agentId: 'claude-code:h:s', kind: 'claude-code', host: 'h', sessionId: 's', status: 'idle', updatedAt: 1, ...over });

async function boot(opts: { fetchImpl?: any; snapshot?: () => any[]; onCommand?: any } = {}) {
  MockWS.reset();
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).WebSocket = MockWS;
  (globalThis as any).fetch = opts.fetchImpl ?? okRegister();
  const { Uplink } = await import('../runtime');
  const { ALL_ADAPTERS } = await import('../adapters/registry');
  const u = new Uplink({
    commanderUrl: 'https://cmd', credential: { token: 'cmdr_ak_x' },
    adapters: ALL_ADAPTERS.filter((a) => a.kind === 'claude-code'),
    snapshotProvider: opts.snapshot ?? (() => []),
    onCommand: opts.onCommand ?? (async (c: any) => ({ cmdId: c.cmdId, status: 'delivered' as const })),
  });
  const conn = () => (u as any).conns[0];
  const restore = async () => { await u.stop(); (globalThis as any).fetch = origFetch; delete (globalThis as any).WebSocket; };
  return { u, conn, restore };
}

// ── tests ──────────────────────────────────────────────────────
test('Uplink: no credential / no URL are no-op sinks', async () => {
  const { Uplink } = await import('../runtime');
  const mk = (over: any) => new Uplink({
    adapters: [], snapshotProvider: () => [],
    onCommand: async () => ({ cmdId: '1', status: 'delivered' as const }), ...over,
  });
  for (const u of [mk({ /* no URL, no credential */ }), mk({ commanderUrl: 'https://x' /* no credential */ })]) {
    u.start();
    u.sendStatus(st());
    await u.stop();
  }
});

test('Uplink: full happy path', async () => {
  const sent = () => MockWS.sent.join('\n');
  const { u, conn, restore } = await boot({ snapshot: () => [st(), st({ kind: 'gemini', agentId: 'gemini:h:s' })] });
  u.start();
  await tick();
  const ws = MockWS.last();
  assert.deepEqual(ws.protocols, ['acap.v1.bearer.tok']);
  assert.equal(ws.url, 'wss://cmd/v1/agent');
  ws.open();
  // status before hello → buffered
  u.sendStatus(st({ agentId: 'claude-code:h:buf', sessionId: 'buf' }));
  assert.ok(!sent().includes('"type":"status"'), 'nothing sent before hello');
  ws.msg(hello());
  // flush: claude-code roster + buffered drained; gemini filtered out
  assert.ok(sent().includes('claude-code:h:s'));
  assert.ok(sent().includes('claude-code:h:buf'));
  assert.ok(!sent().includes('gemini:h:s'));
  // ping → pong
  ws.msg(ping());
  assert.ok(sent().includes('"type":"pong"'));
  // cmd → ack delivered
  ws.msg(cmd({ cmdId: 'c1', intent: 'prompt', prompt: 'hi' }));
  await tick();
  assert.ok(sent().includes('"type":"ack"') && sent().includes('c1') && sent().includes('delivered'));
  // duplicate cmdId → ack duplicate
  MockWS.sent = [];
  ws.msg(cmd({ cmdId: 'c1', intent: 'prompt', prompt: 'hi' }));
  await tick();
  assert.ok(sent().includes('duplicate'));
  // status after hello (minStatusMs 0) → immediate
  MockWS.sent = [];
  u.sendStatus(st({ status: 'busy', updatedAt: 9 }));
  assert.ok(sent().includes('"status":"busy"'));
  // Uplink.sendStatus with no matching conn → no-op
  u.sendStatus(st({ kind: 'gemini', agentId: 'gemini:h:s' }));
  // a minimal hello exercises the default-heartbeat/min branches
  ws.msg({ type: 'hello', v: 1, ts: '', id: 'x', data: { acap: '1.0', accepted: {} } });
  await restore();
});

test('Uplink: malformed / unknown / wrong-version inbound are ignored', async () => {
  const { u, restore } = await boot();
  u.start();
  await tick();
  const ws = MockWS.last();
  ws.open();
  ws.msg(hello());
  MockWS.sent = [];
  ws.raw('not json{');                                   // JSON.parse throws → ignored
  ws.raw('null');                                        // !env → ignored
  ws.msg({ type: 'status', v: 2, ts: '', id: 'x', data: {} }); // wrong version → ignored
  ws.msg({ type: 'event', v: 1, ts: '', id: 'x', data: {} });  // unknown type → ignored
  ws.msg({ type: 'pong', v: 1, ts: '', id: 'x', data: {} });   // pong → default ignored
  assert.equal(MockWS.sent.length, 0);
  await restore();
});

test('Uplink: onCommand throw → ack rejected agent-error; cmd without cmdId skips dedup', async () => {
  const { u, restore } = await boot({ onCommand: async () => { throw new Error('boom'); } });
  u.start();
  await tick();
  const ws = MockWS.last();
  ws.open();
  ws.msg(hello());
  MockWS.sent = [];
  ws.msg(cmd({ cmdId: 'x1', intent: 'prompt', prompt: 'p' }));
  await tick();
  assert.ok(MockWS.sent.join().includes('rejected') && MockWS.sent.join().includes('agent-error'));
  // cmd without cmdId: dedup skipped, still acked (agentId falls back to data.agentId)
  MockWS.sent = [];
  ws.msg(cmd({ intent: 'prompt', prompt: 'p', agentId: 'claude-code:h:z' }, ''));
  await tick();
  assert.ok(MockWS.sent.join().includes('"type":"ack"'));
  await restore();
});

test('Uplink: close codes — 4403 backs off, 4429 slows, others reconnect', async () => {
  for (const code of [4403, 4429, 4408]) {
    const { u, conn, restore } = await boot();
    u.start();
    await tick();
    const ws = MockWS.last();
    ws.open();
    ws.msg(hello({ minStatusIntervalMs: 0 }));
    ws.close(code);
    assert.notEqual(conn().reconnectTimer, null, `reconnect scheduled for ${code}`);
    if (code === 4429) assert.equal(conn().minStatusMs, 250); // doubled from 0 → floored to 250
    await restore();
  }
});

test('Uplink: register failure schedules a reconnect with no socket', async () => {
  const { u, conn, restore } = await boot({ fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'err' }) });
  u.start();
  await tick();
  assert.equal(MockWS.instances.length, 0);
  assert.notEqual(conn().reconnectTimer, null);
  await restore();
});

test('Uplink: missing global WebSocket and a throwing constructor both reconnect', async () => {
  // WebSocket vanishes by the time openWs runs (register deletes it).
  const a = await boot({ fetchImpl: async () => { delete (globalThis as any).WebSocket; return { ok: true, json: async () => ({ v: 1, wsToken: 't', wsUrl: 'wss://c/v1/agent' }) }; } });
  a.u.start();
  await tick();
  assert.equal(MockWS.instances.length, 0);
  assert.notEqual(a.conn().reconnectTimer, null);
  await a.restore();

  // constructor throws → caught → reconnect
  const b = await boot();
  (globalThis as any).WebSocket = class { constructor() { throw new Error('construct'); } };
  b.u.start();
  await tick();
  assert.notEqual(b.conn().reconnectTimer, null);
  await b.restore();
});

test('Uplink: register without expiry/heartbeat uses defaults', async () => {
  const { u, restore } = await boot({ fetchImpl: okRegister({ expiresInSec: 0, heartbeatSec: 0 }) });
  u.start();
  await tick();
  MockWS.last().open();
  MockWS.last().msg(hello());
  await restore();
});

test('Uplink: minStatusIntervalMs coalesces rapid statuses', async () => {
  const { u, conn, restore } = await boot();
  u.start();
  await tick();
  const ws = MockWS.last();
  ws.open();
  ws.msg(hello({ minStatusIntervalMs: 1000 }));
  MockWS.sent = [];
  u.sendStatus(st({ status: 'idle', updatedAt: 1 }));      // first → immediate
  assert.equal(MockWS.sent.length, 1);
  u.sendStatus(st({ status: 'busy', updatedAt: 2 }));      // within floor → coalesced (sets flushTimer)
  u.sendStatus(st({ status: 'error', updatedAt: 3 }));     // still coalesced (flushTimer already set)
  assert.equal(MockWS.sent.length, 1, 'coalesced, not sent yet');
  conn().drainPending();                                   // trailing flush
  assert.ok(MockWS.sent.join().includes('"status":"error"'));
  ws.close(1000);
  conn().drainPending();                                   // not connected → early return
  await restore();
});

test('Uplink: heartbeat/expiry timers fire, send errors are caught, pending flush is cleared on close', async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const a = await boot();
  a.u.start();
  await tick();
  const ws = MockWS.last();
  ws.open();
  ws.msg(hello({ minStatusIntervalMs: 1000 }));
  const c = a.conn();
  // (1) a throwing ws.send is caught, not propagated
  ws.send = () => { throw new Error('send-broke'); };
  ws.msg(ping());                                   // → send(pong) throws → caught
  ws.send = (d: string) => { MockWS.sent.push(d); };
  // (2) watchdog fires → close(4408)
  c.heartbeatSec = 0; c.armWatchdog();
  await sleep(5);
  // (3) expiry fires (socket already gone) → close(4401) line runs
  c.armExpiry(0);
  await sleep(5);
  await a.restore();

  // (4) close while a coalesce flushTimer is still pending → it gets cleared
  const b = await boot();
  b.u.start();
  await tick();
  const ws2 = MockWS.last();
  ws2.open();
  ws2.msg(hello({ minStatusIntervalMs: 1000 }));
  b.u.sendStatus(st({ updatedAt: 1 }));              // immediate
  b.u.sendStatus(st({ status: 'busy', updatedAt: 2 })); // coalesced → flushTimer pending
  ws2.close(1000);                                  // clearTransientTimers clears the pending flushTimer
  await b.restore();
});

test('Uplink: cmd dedup remembers, rejects repeats, and evicts beyond the cap', async () => {
  const { u, conn, restore } = await boot();
  u.start();
  await tick();
  const c: any = conn();
  assert.equal(c.rememberCmd('a'), true);
  assert.equal(c.rememberCmd('a'), false);           // duplicate
  for (let i = 0; i < 1100; i++) c.rememberCmd('k' + i); // overflow → eviction branch
  assert.equal(c.rememberCmd('fresh'), true);
  await restore();
});

test('Uplink: connect() guards on closing before and after register', async () => {
  const { u, conn, restore } = await boot();
  u.start();
  await tick();
  const c = conn();
  // first guard: closing already set
  c.closing = true;
  await c.connect();
  c.closing = false;
  // second guard: closing flips during the register await
  (globalThis as any).fetch = async () => { c.closing = true; return { ok: true, json: async () => ({ v: 1, wsToken: 't', wsUrl: 'wss://c/v1/agent' }) }; };
  const before = MockWS.instances.length;
  await c.connect();
  assert.equal(MockWS.instances.length, before, 'no socket opened when closing mid-register');
  c.closing = false;
  await restore();
});
