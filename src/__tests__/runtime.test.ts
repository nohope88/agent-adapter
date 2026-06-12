import { test } from 'node:test';
import assert from 'node:assert/strict';

type Listener = (ev?: unknown) => void;

class MockWebSocket {
  static sent: string[] = [];
  readyState = 0;
  private listeners: Record<string, Listener[]> = {};
  constructor(_url: string) {
    setImmediate(() => {
      this.readyState = 1;
      for (const fn of this.listeners.open || []) fn();
    });
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) { MockWebSocket.sent.push(data); }
  close() {
    this.readyState = 3;
    for (const fn of this.listeners.close || []) fn({ code: 1000 });
  }
  pushMessage(data: unknown) {
    for (const fn of this.listeners.message || []) fn({ data: JSON.stringify(data) });
  }
}

test('Uplink: local mode is a no-op sink', async () => {
  const { Uplink } = await import('../runtime');
  const u = new Uplink({
    local: true, adapters: [], snapshotProvider: () => [],
    onCommand: async () => ({ v: 1, cmdId: '1', status: 'delivered' }),
  });
  u.start();
  u.sendStatus({ v: 1, agentId: 'a', kind: 'x', host: 'h', sessionId: 's', ts: '', status: 'idle' });
  await u.stop();
});

test('Uplink: registers, flushes buffer, handles cmd, token refresh on auth close', async () => {
  MockWebSocket.sent = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;

  const { Uplink } = await import('../runtime');
  const { envelope } = await import('../protocol');
  const { ALL_ADAPTERS } = await import('../adapters/registry');

  let refreshed = false;
  const u = new Uplink({
    local: false,
    commanderUrl: 'wss://cmd.example/agent?token=old',
    credential: { token: 'tok', refresh: async () => { refreshed = true; return 'tok2'; } },
    adapters: ALL_ADAPTERS.slice(0, 1),
    snapshotProvider: () => [{
      v: 1, agentId: 'claude-code:host:s', kind: 'claude-code', host: 'host', sessionId: 's', ts: '', status: 'idle',
    }],
    onCommand: async (cmd) => ({ v: 1, cmdId: cmd.cmdId, status: 'delivered' }),
  });

  u.sendStatus({
    v: 1, agentId: 'claude-code:host:s2', kind: 'claude-code', host: 'host', sessionId: 's2', ts: '', status: 'working',
  });
  u.start();
  await new Promise((r) => setImmediate(r));

  assert.ok(MockWebSocket.sent.some((s) => s.includes('"type":"register"')));
  const ws = (u as unknown as { ws: MockWebSocket }).ws;
  ws.pushMessage(envelope('cmd', {
    v: 1, cmdId: 'c1', ts: '', agentId: 'claude-code:host:s', source: 't', intent: 'prompt', prompt: 'hi',
  }));
  await new Promise((r) => setImmediate(r));

  for (const fn of (ws as unknown as { listeners: Record<string, Listener[]> }).listeners.close || []) {
    fn({ code: 4401 });
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(refreshed, true);

  await u.stop();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

test('Uplink: missing WebSocket and onCommand throw', async () => {
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
  const { Uplink } = await import('../runtime');
  const u = new Uplink({
    local: false, commanderUrl: 'wss://x', adapters: [],
    snapshotProvider: () => [], onCommand: async () => { throw new Error('nope'); },
  });
  u.start();
  await u.stop();

  MockWebSocket.sent = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  const { envelope } = await import('../protocol');
  const u2 = new Uplink({
    local: false, commanderUrl: 'wss://x', adapters: [],
    snapshotProvider: () => [], onCommand: async () => { throw new Error('nope'); },
  });
  u2.start();
  await new Promise((r) => setImmediate(r));
  (u2 as unknown as { ws: MockWebSocket }).ws.pushMessage(envelope('cmd', {
    v: 1, cmdId: 'e', ts: '', agentId: 'a', source: 't', intent: 'prompt',
  }));
  await new Promise((r) => setImmediate(r));
  assert.ok(MockWebSocket.sent.some((s) => s.includes('rejected')));
  await u2.stop();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

test('Uplink: ws construct failure and refresh failure paths', async () => {
  class BadWS {
    constructor() { throw new Error('nope'); }
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = BadWS;
  const { Uplink } = await import('../runtime');
  const u = new Uplink({
    local: false, commanderUrl: 'wss://x', adapters: [],
    snapshotProvider: () => [], onCommand: async (c) => ({ v: 1, cmdId: c.cmdId, status: 'delivered' }),
    credential: { token: 't', refresh: async () => { throw new Error('refresh-fail'); } },
  });
  u.start();
  await new Promise((r) => setImmediate(r));
  await u.stop();

  class MockWS {
    private listeners: Record<string, Array<(ev?: unknown) => void>> = {};
    constructor() { setImmediate(() => { for (const fn of this.listeners.close || []) fn({ code: 4401 }); }); }
    addEventListener(t: string, fn: (ev?: unknown) => void) { (this.listeners[t] ??= []).push(fn); }
    send() {}
    close() {}
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWS;
  const u2 = new Uplink({
    local: false, commanderUrl: 'wss://x?token=old', adapters: [],
    snapshotProvider: () => [{ v: 1, agentId: 'a:h:s', kind: 'x', host: 'h', sessionId: 's', ts: '', status: 'idle' }],
    onCommand: async (c) => ({ v: 1, cmdId: c.cmdId, status: 'delivered' }),
    credential: { token: 't', refresh: async () => { throw new Error('refresh-fail'); } },
  });
  u2.start();
  await new Promise((r) => setImmediate(r));
  await u2.stop();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

test('Uplink: sendStatus while connected sends immediately; malformed inbound ignored', async () => {
  MockWebSocket.sent = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  const { Uplink } = await import('../runtime');
  const u = new Uplink({
    local: false, commanderUrl: 'wss://x', adapters: [],
    snapshotProvider: () => [], onCommand: async (c) => ({ v: 1, cmdId: c.cmdId, status: 'delivered' }),
  });
  u.start();
  await new Promise((r) => setImmediate(r)); // open fires → connected

  u.sendStatus({ v: 1, agentId: 'a', kind: 'x', host: 'h', sessionId: 's', ts: '', status: 'idle' });
  assert.ok(MockWebSocket.sent.some((s) => s.includes('"type":"status"')), 'connected sendStatus sends now');

  // Raw non-JSON inbound message → onMessage JSON.parse catch, no throw.
  const ws = (u as unknown as { ws: MockWebSocket }).ws;
  for (const fn of (ws as unknown as { listeners: Record<string, Listener[]> }).listeners.message || []) {
    fn({ data: 'not-json{' });
  }
  await new Promise((r) => setImmediate(r));
  await u.stop();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

test('Uplink: a throwing ws.send is logged, not propagated', async () => {
  class ThrowingWS {
    private listeners: Record<string, Listener[]> = {};
    constructor() { setImmediate(() => { for (const fn of this.listeners.open || []) fn(); }); }
    addEventListener(t: string, fn: Listener) { (this.listeners[t] ??= []).push(fn); }
    send() { throw new Error('send-broke'); }
    close() {}
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = ThrowingWS;
  const { Uplink } = await import('../runtime');
  const { ALL_ADAPTERS } = await import('../adapters/registry');
  const u = new Uplink({
    local: false, commanderUrl: 'wss://x', adapters: ALL_ADAPTERS.slice(0, 1),
    snapshotProvider: () => [], onCommand: async (c) => ({ v: 1, cmdId: c.cmdId, status: 'delivered' }),
  });
  u.start();
  await new Promise((r) => setImmediate(r)); // open → register → send() throws → caught
  await u.stop();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

test('Uplink: open() is a no-op once closing', async () => {
  const { Uplink } = await import('../runtime');
  const u = new Uplink({
    local: false, commanderUrl: 'wss://x', adapters: [],
    snapshotProvider: () => [], onCommand: async (c) => ({ v: 1, cmdId: c.cmdId, status: 'delivered' }),
  });
  (u as unknown as { closing: boolean }).closing = true;
  (u as unknown as { open: () => void }).open();
  assert.equal((u as unknown as { ws: unknown }).ws, null);
});
