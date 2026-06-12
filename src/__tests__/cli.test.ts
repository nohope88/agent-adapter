import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.join(__dirname, '..', 'cli.js');

function run(args: string[], env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_ADAPTER_SKIP_DAEMON: '1', ...env },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.stderr || '' };
}

test('cli: help and unknown command', () => {
  assert.ok(run(['help']).out.includes('agent-adapter'));
  assert.equal(run(['nope']).status, 2);
  assert.ok(run([]).out.includes('start'));
});

test('cli: verify and detect', () => {
  assert.equal(run(['verify']).status, 0);
  assert.ok(run(['detect']).out.includes('claude-code'));
});

test('cli: login flows', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli-'));
  const env = { AGENT_ADAPTER_HOME: path.join(home, '.agent-adapter') };
  assert.ok(run(['login'], env).out.includes('device-code'));
  assert.ok(run(['login', '--token', 't', '--commander', 'wss://x'], env).out.includes('Credential saved'));
});

test('cli: status fails when hub is down', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli2-'));
  const r = run(['status'], { AGENT_ADAPTER_HOME: path.join(home, '.aa'), AGENT_ADAPTER_CONTROL_PORT: '7991' });
  assert.equal(r.status, 1);
});

test('cli: answer usage and command against subprocess hub', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli3-'));
  const env: Record<string, string> = {
    AGENT_ADAPTER_HOME: path.join(home, '.aa'),
    AGENT_ADAPTER_CONTROL_PORT: '7812',
    AGENT_ADAPTER_SKIP_DAEMON: '1',
  };
  assert.equal(run(['answer'], env).status, 2);

  const hubProc = spawn(process.execPath, [CLI, 'start', '--local'], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 600));
  try {
    await fetch('http://127.0.0.1:7812/ingest', {
      method: 'POST',
      body: JSON.stringify({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 's', title: 't' }),
    });
    const host = os.hostname().split('.')[0];
    const id = `claude-code:${host}:s`;
    assert.ok(run(['status'], env).out.includes('idle') || run(['status'], env).out.includes('s'));
    assert.ok(run(['answer', id, 'yes'], env).out.includes('rejected') || run(['answer', id, 'yes'], env).out.includes('delivered'));
    assert.ok(run(['prompt', id, 'hi'], env).out.includes('status'));
    assert.ok(run(['interrupt', id], env).out.includes('status'));
  } finally {
    hubProc.kill('SIGTERM');
    await new Promise((r) => hubProc.on('close', r));
  }
});

test('cli: start --web skips missing dashboard (non-blocking)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli4-'));
  const r = spawnSync(process.execPath, [CLI, 'start', '--local', '--web'], {
    encoding: 'utf8',
    timeout: 1500,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      AGENT_ADAPTER_HOME: path.join(home, '.aa'),
      AGENT_ADAPTER_CONTROL_PORT: '7813',
    },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('running') || out.includes('web UI not found'));
});
