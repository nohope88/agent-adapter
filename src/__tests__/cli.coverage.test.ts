import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.join(__dirname, '..', 'cli.js');

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

test('cli: install, uninstall, help, prompt usage, command failure', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ch2-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = { HOME: home, AGENT_ADAPTER_HOME: path.join(home, '.agent-adapter') };
  assert.ok(run(['install'], env).stdout.includes('Detected agents'));
  assert.ok(run(['uninstall'], env).stdout.includes('Hooks removed'));
  assert.ok(run(['--help']).stdout.includes('answer'));
  assert.equal(run(['prompt'], env).status, 2);
  assert.equal(run(['status'], { AGENT_ADAPTER_CONTROL_PORT: '7998' }).status, 1);
});

test('cli: status roster with waiting session and uplink start line', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ch3-'));
  const env = {
    AGENT_ADAPTER_HOME: path.join(home, '.aa'),
    AGENT_ADAPTER_CONTROL_PORT: '7815',
  };
  const hub = spawn(process.execPath, [CLI, 'start', '--local'], { env: { ...process.env, ...env }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  try {
    await fetch('http://127.0.0.1:7815/ingest', {
      method: 'POST',
      body: JSON.stringify({
        v: 1, kind: 'claude-code', event: 'PreToolUse', sessionId: 'w',
        tool: 'AskUserQuestion', toolInput: { question: 'Q?', options: ['a'] }, title: 't',
      }),
    });
    const st = run(['status'], env);
    assert.ok(st.stdout.includes('waiting') || st.stdout.includes('⚠'));
  } finally {
    hub.kill('SIGTERM');
    await new Promise((r) => hub.on('close', r));
  }
});

test('cli: start with existing web dashboard spawns child', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ch4-'));
  const r = spawnSync(process.execPath, [CLI, 'start', '--local', '--web', '--web-port', '8792'], {
    encoding: 'utf8',
    timeout: 1200,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      AGENT_ADAPTER_HOME: path.join(home, '.aa'),
      AGENT_ADAPTER_CONTROL_PORT: '7816',
    },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(out.includes('dashboard:') || out.includes('running'));
});
