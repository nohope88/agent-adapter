import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.join(__dirname, '..', 'cli.js');

function run(args: string[], env: Record<string, string>, input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    env: { PATH: process.env.PATH, HOME: env.HOME || process.env.HOME, ...env },
  });
}

test('cli subprocess covers hook, interrupt, login, help, unknown', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clibr-'));
  const base = { HOME: home, AGENT_ADAPTER_HOME: path.join(home, '.aa'), AGENT_ADAPTER_SKIP_DAEMON: '1' };
  assert.equal(run(['hook', '--kind', 'claude-code', '--event', 'Stop', '--reply', 'none'], base, '{}').status, 0);
  assert.equal(run(['interrupt'], base).status, 2);
  assert.ok(run(['login', '--token', 'tok'], base).stdout.includes('Credential saved'));
  assert.ok(run(['--help'], base).stdout.includes('login'));
  assert.equal(run(['not-a-cmd'], base).status, 2);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  assert.ok(run(['install'], base).stdout.includes('Detected agents'));
  assert.ok(run(['uninstall'], base).stdout.includes('Hooks removed'));
});
