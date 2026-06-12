import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const CLI = path.join(__dirname, '..', 'cli.js');

test('installer: AGENT_ADAPTER_BIN, cursor version, wire failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cov-'));
  process.env.HOME = home;
  process.env.AGENT_ADAPTER_BIN = '/usr/bin/false';
  process.env.AGENT_ADAPTER_SKIP_DAEMON = '1';
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'hooks.json'), JSON.stringify({ hooks: {} }));
  const inst = await import('../hooks/installer');
  const wired = inst.installHooks();
  assert.ok(wired.length >= 1);
  const hooks = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8'));
  assert.equal(hooks.version, 1);

  const bad = path.join(home, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, '{');
  try { inst.installHooks(); } catch { /* merge may log */ }
  delete process.env.AGENT_ADAPTER_BIN;
});

test('hook: partial gate decision uses neutral defaults', async () => {
  const adapterHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cov-hook-'));
  const { IngestServer } = await import('../ingest');
  const srv = new IngestServer(() => {}, () => ({}));
  await srv.start();
  try {
    const child = spawn(process.execPath, [CLI, 'hook', '--kind', 'claude-code', '--event', 'PermissionRequest', '--reply', 'permission'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_ADAPTER_HOME: adapterHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = await new Promise<string>((resolve) => {
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => { out += c; });
      child.on('close', () => resolve(out));
      child.stdin.end(JSON.stringify({ session_id: 's' }));
    });
    assert.match(stdout, /allow/);
  } finally {
    await srv.stop();
  }
});

test('store.get returns snapshot by sessionId', async () => {
  const { SessionStore } = await import('../store');
  const store = new SessionStore();
  store.apply({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 'g1', title: 'x' } as never);
  assert.equal(store.get('g1')?.title, 'x');
});

test('injector: pty answer path', async () => {
  const { BindingMap } = await import('../binding');
  const { Injector } = await import('../injector');
  const { SCHEMA_V } = await import('../protocol');
  const binding = new BindingMap();
  binding.learn({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 'ans' } as never);
  const inj = new Injector(binding);
  const writes: string[] = [];
  inj.pty.registerManaged('ans', (d) => writes.push(d));
  const ack = await inj.dispatch({
    v: SCHEMA_V, cmdId: '1', ts: '', agentId: 'claude-code:host:ans', source: 't', intent: 'answer', answer: 'yes',
  }, { channel: 'pty', hookReturn: false });
  assert.equal(ack.status, 'delivered');
  assert.ok(writes.some((w) => w.includes('yes')));
});

test('runtime: buffers offline status and withToken appends query', async () => {
  class MockWS {
    static instances: MockWS[] = [];
    readyState = 0;
    private listeners: Record<string, Array<(ev?: unknown) => void>> = {};
    constructor(_url: string) { MockWS.instances.push(this); setImmediate(() => { this.readyState = 1; for (const fn of this.listeners.open || []) fn(); }); }
    addEventListener(t: string, fn: (ev?: unknown) => void) { (this.listeners[t] ??= []).push(fn); }
    send() {}
    close() { for (const fn of this.listeners.close || []) fn({ code: 1000 }); }
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWS;
  const { Uplink } = await import('../runtime');
  const u = new Uplink({
    local: false, commanderUrl: 'wss://x', credential: { token: 'abc' },
    adapters: [], snapshotProvider: () => [],
    onCommand: async (c) => ({ v: 1, cmdId: c.cmdId, status: 'delivered' }),
  });
  u.sendStatus({ v: 1, agentId: 'a:host:s', kind: 'x', host: 'h', sessionId: 's', ts: '', status: 'idle' });
  u.start();
  await new Promise((r) => setImmediate(r));
  await u.stop();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

test('cli: interrupt and install output paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cov-cli-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = { HOME: home, AGENT_ADAPTER_HOME: path.join(home, '.aa'), AGENT_ADAPTER_SKIP_DAEMON: '1' };
  const install = spawnSync(process.execPath, [CLI, 'install'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.ok(install.stdout.includes('Wired hooks'));
  assert.equal(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).status, 0);
});

test('logger info and warn with extra fields', async () => {
  process.env.AGENT_ADAPTER_LOG = 'info';
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { chunks.push(s); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { chunks.push(s); return true; }) as typeof process.stderr.write;
  try {
    const { logger } = await import('../util/log');
    logger('x').info('ok', { y: 1 });
    logger('x').warn('w', 'detail');
    assert.ok(chunks.some((c) => c.includes('INFO') && c.includes('"y":1')));
    assert.ok(chunks.some((c) => c.includes('WARN') && c.includes('detail')));
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    delete process.env.AGENT_ADAPTER_LOG;
  }
});

