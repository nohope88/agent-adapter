import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { BindingMap } from '../binding';
import { Injector } from '../injector';
import { PtyInjector } from '../injector/pty';
import { Command, Intent, SCHEMA_V } from '../protocol';
import { InjectTarget } from '../binding';

const cmd = (intent: Intent, extra: Record<string, string> = {}): Command => ({
  v: SCHEMA_V, cmdId: '1', ts: '', agentId: 'claude-code:host:sid', source: 't', intent, ...extra,
});

const target = (over: Partial<InjectTarget> & { sessionId: string }): InjectTarget => ({
  kind: 'claude-code', updatedAt: Date.now(), ...over,
});

test('injector: hookReturn answer on read-only adapter', async () => {
  const inj = new Injector(new BindingMap());
  const ack = await inj.dispatch(cmd('answer', { answer: 'yes' }), { channel: 'none', hookReturn: true });
  assert.equal(ack.status, 'delivered');
});

test('injector: native channel posts to control endpoint', async () => {
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { res.writeHead(200); res.end('ok'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const binding = new BindingMap();
  binding.learn({ v: 1, kind: 'openclaw', event: 'SessionStart', sessionId: 'sid',
    controlEndpoint: `http://127.0.0.1:${port}/ctl` } as never);
  const inj = new Injector(binding);
  const ack = await inj.dispatch(cmd('prompt', { prompt: 'go' }), { channel: 'native', hookReturn: false });
  assert.equal(ack.status, 'delivered');
  server.close();
});

test('injector: pty managed path for prompt/interrupt/mode', async () => {
  const binding = new BindingMap();
  binding.learn({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 'sid', pid: 1 } as never);
  const inj = new Injector(binding);
  const writes: string[] = [];
  inj.pty.registerManaged('sid', (d) => writes.push(d));
  const p = await inj.dispatch(cmd('prompt', { prompt: 'hi' }), { channel: 'pty', hookReturn: false });
  assert.equal(p.status, 'delivered');
  assert.ok(writes.some((w) => w.includes('hi')));
  const i = await inj.dispatch(cmd('interrupt'), { channel: 'pty', hookReturn: false });
  assert.equal(i.status, 'delivered');
  const m = await inj.dispatch(cmd('mode', { mode: 'plan' }), { channel: 'pty', hookReturn: false });
  assert.equal(m.status, 'rejected');
  inj.pty.unregisterManaged('sid');
});

test('injector: nosession and NoTargetError paths', async () => {
  const binding = new BindingMap();
  const inj = new Injector(binding);
  const ns = await inj.dispatch(
    { ...cmd('prompt', { prompt: 'x' }), agentId: 'claude-code:host:missing' },
    { channel: 'pty', hookReturn: false },
  );
  assert.equal(ns.status, 'nosession');
  binding.learn({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 'sid2' } as never);
  const rej = await inj.dispatch(
    { ...cmd('prompt', { prompt: 'x' }), agentId: 'claude-code:host:sid2' },
    { channel: 'pty', hookReturn: false },
  );
  assert.equal(rej.status, 'rejected');
  assert.match(rej.detail || '', /no inject target/);
});

test('injector: pty answer path and unknown intent', async () => {
  const binding = new BindingMap();
  binding.learn({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 'sid', pid: 1 } as never);
  const inj = new Injector(binding);
  const writes: string[] = [];
  inj.pty.registerManaged('sid', (d) => writes.push(d));
  const a = await inj.dispatch(cmd('answer', { answer: 'yes' }), { channel: 'pty', hookReturn: false });
  assert.equal(a.status, 'delivered');
  assert.ok(writes.some((w) => w.includes('yes')));
  const bad = await inj.dispatch(cmd('zap' as Intent), { channel: 'pty', hookReturn: false });
  assert.equal(bad.status, 'rejected');
  assert.match(bad.detail || '', /unknown intent/);
  inj.pty.unregisterManaged('sid');
});

test('pty: tmux path errors become NoTargetError', async () => {
  const pty = new PtyInjector();
  const t = target({ sessionId: 'z', pid: 0, cwd: '/no/such/path' });
  await assert.rejects(() => pty.typeText(t, 'x'), /no pty target/);
  await assert.rejects(() => pty.sendKey(t, 'Escape'), /no pty target/);
});
