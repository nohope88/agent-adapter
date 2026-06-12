import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.join(__dirname, '..', 'cli.js');

// `start` now requires login; seed a credential + a dead Commander so the hub
// boots (control API works) without any real network.
const DEAD_COMMANDER = 'http://127.0.0.1:1';
function seedCred(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({ token: 'cmdr_ak_test' }));
}

function run(args: string[], env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_ADAPTER_SKIP_DAEMON: '1', ...env },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.stderr || '' };
}

test('cli: help and unknown command', () => {
  assert.ok(run(['help']).out.includes('aca'));
  assert.equal(run(['nope']).status, 2);
  assert.ok(run([]).out.includes('setup'));
});

test('cli: selfcheck (acap conformance)', () => {
  assert.equal(run(['selfcheck']).status, 0);
});

test('cli: verify reconciles in an isolated home', () => {
  // Point detection at an empty temp home so no real ~/.claude is touched.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cliv-'));
  const env = { HOME: home, USERPROFILE: home, AGENT_ADAPTER_HOME: path.join(home, '.agent-adapter') };
  const r = run(['verify'], env);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('In sync'));
});

test('cli: login then logout flows', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli-'));
  const env = { AGENT_ADAPTER_HOME: path.join(home, '.agent-adapter') };
  assert.ok(run(['login'], env).out.includes('tenant API key'));
  assert.ok(run(['login', '--token', 't', '--commander', 'wss://x'], env).out.includes('Credential saved'));
  assert.ok(run(['logout'], env).out.includes('Logged out'));
  assert.ok(run(['logout'], env).out.includes('Not logged in')); // already gone
});

test('cli: start --web skips missing dashboard (non-blocking)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cli4-'));
  seedCred(path.join(home, '.aa'));
  const r = spawnSync(process.execPath, [CLI, 'start', '--web'], {
    encoding: 'utf8',
    timeout: 1500,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      AGENT_ADAPTER_HOME: path.join(home, '.aa'),
      AGENT_ADAPTER_CONTROL_PORT: '7813',
      AGENT_ADAPTER_COMMANDER: DEAD_COMMANDER,
    },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('running') || out.includes('web UI not found'));
});
