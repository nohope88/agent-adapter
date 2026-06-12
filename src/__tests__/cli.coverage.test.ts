import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.join(__dirname, '..', 'cli.js');

// `start` now requires login; seed a credential and point the uplink at a dead
// localhost so the hub boots (control API works) without any real network.
const DEAD_COMMANDER = 'http://127.0.0.1:1';
function seedCred(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'credentials.json'), JSON.stringify({ token: 'cmdr_ak_test' }));
}

function run(args: string[], env: Record<string, string> = {}, input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, AGENT_ADAPTER_SKIP_DAEMON: '1', ...env },
  });
}

test('cli: hook subcommand via main entry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ch-'));
  const r = run(['hook', '--kind', 'claude-code', '--event', 'Stop', '--reply', 'none'], {
    AGENT_ADAPTER_HOME: path.join(home, '.aa'),
  }, '{}');
  assert.equal(r.status, 0);
});

test('cli: setup, verify, uninstall, help, logout, unknown usage', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ch2-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = { HOME: home, USERPROFILE: home, AGENT_ADAPTER_HOME: path.join(home, '.agent-adapter') };
  assert.ok(run(['setup'], env).stdout.includes('Detected agents'));
  assert.ok(run(['verify'], env).stdout.includes('In sync'));
  assert.ok(run(['uninstall'], env).stdout.includes('Hooks removed'));
  assert.ok(run(['--help']).stdout.includes('verify'));
  assert.equal(run(['prompt'], env).status, 2); // removed command → unknown → exit 2
  assert.equal(run(['logout'], env).status, 0);
});

test('cli: start with existing web dashboard spawns child', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ch4-'));
  seedCred(path.join(home, '.aa'));
  const r = spawnSync(process.execPath, [CLI, 'start', '--web', '--web-port', '8792'], {
    encoding: 'utf8',
    timeout: 1200,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      AGENT_ADAPTER_HOME: path.join(home, '.aa'),
      AGENT_ADAPTER_CONTROL_PORT: '7816',
      AGENT_ADAPTER_COMMANDER: DEAD_COMMANDER,
    },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('dashboard:') || out.includes('running'));
});
