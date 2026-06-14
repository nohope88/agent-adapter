import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI = path.join(__dirname, '..', 'cli.js');

function hook(args: string[], input: string, adapterHome: string) {
  return spawnSync(process.execPath, [CLI, 'hook', ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, AGENT_ADAPTER_HOME: adapterHome },
  });
}

function hookEnv(adapterHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENT_ADAPTER_HOME: adapterHome,
  };
}

function hookAsync(args: string[], input: string, adapterHome: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', ...args], {
      env: hookEnv(adapterHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ stdout, stderr, status }));
    child.stdin.end(input);
  });
}

test('hook: fail-open returns neutral defaults when hub is down', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hook-'));
  const aa = path.join(home, '.aa');
  assert.match(hook(['--kind', 'claude-code', '--event', 'PreToolUse', '--reply', 'continue'], '{}', aa).stdout, /continue/);
  assert.match(hook(['--kind', 'cursor', '--event', 'Notification', '--reply', 'permission'], '{}', aa).stdout, /allow/);
  assert.equal(hook(['--kind', 'claude-code', '--event', 'Stop', '--reply', 'none'], '{}', aa).stdout, '');
});

test('hook: normalizes cursor and claude payloads', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hook2-'));
  const r = hook(
    ['--kind', 'cursor', '--event', 'PreToolUse', '--reply', 'none'],
    JSON.stringify({ session_id: 'c1', command: 'ls', file_path: '/x', nativeHandle: 'nh', workspaceRoots: ['/p'] }),
    path.join(home, '.aa'),
  );
  assert.equal(r.status, 0);
  const r2 = hook(
    ['--kind', 'claude-code', '--event', 'Stop', '--reply', 'none'],
    JSON.stringify({ session_id: 's', lastResponse: 'hi', tool_input: { x: 1 } }),
    path.join(home, '.aa'),
  );
  assert.equal(r2.status, 0);
});

test('hook: cursor file_path-only payload maps to the Edit shape', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hook4-'));
  // No `command` key → applyCursorShape takes the file_path → Edit branch.
  const r = hook(
    ['--kind', 'cursor', '--event', 'PreToolUse', '--reply', 'none'],
    JSON.stringify({ session_id: 'c2', file_path: '/x/y.ts' }),
    path.join(home, '.aa'),
  );
  assert.equal(r.status, 0);
});

test('hook: an unparseable gate reply falls back to the neutral default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hook5-'));
  const server = net.createServer((c) => { c.on('data', () => c.write('garbage-not-json\n')); });
  await new Promise<void>((resolve) => {
    // Windows: bind TCP and publish the port so the child's readIngestPort finds
    // it; POSIX: the unix socket the child derives from AGENT_ADAPTER_HOME.
    if (process.platform === 'win32') {
      server.listen(0, '127.0.0.1', () => {
        fs.writeFileSync(path.join(root, 'ingest.port'), String((server.address() as net.AddressInfo).port));
        resolve();
      });
    } else {
      server.listen(path.join(root, 'ingest.sock'), resolve);
    }
  });
  try {
    // Full env (so NODE_V8_COVERAGE propagates) + async spawn (so the in-process
    // server can answer): the child reads garbage, JSON.parse throws, done(null).
    const out = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        [CLI, 'hook', '--kind', 'claude-code', '--event', 'PreToolUse', '--reply', 'continue'],
        { env: { ...process.env, AGENT_ADAPTER_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let s = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => { s += c; });
      child.on('close', () => resolve(s));
      child.stdin.end(JSON.stringify({ session_id: 's' }));
    });
    assert.match(out, /"continue":true/);
  } finally {
    server.close();
  }
});

test('hook: gate decision paths via ingest', async () => {
  const adapterHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hook3-'));
  process.env.AGENT_ADAPTER_HOME = adapterHome;
  const { IngestServer } = await import('../ingest');
  const { PATHS, isWindows, readIngestPort } = await import('../util/paths');
  const gate = () => ({ permission: 'deny', continue: false });
  let active = new IngestServer(() => {}, gate);
  await active.start();
  if (!isWindows) assert.ok(fs.existsSync(PATHS.ingestSock));
  try {
    const post = (event: string, reply: string, sessionId: string) =>
      new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
        // Windows: dial the server's published (ephemeral) port; POSIX: socket.
        const sock = isWindows ? net.connect(readIngestPort(), '127.0.0.1') : net.connect(PATHS.ingestSock);
        let buf = '';
        const fail = setTimeout(() => {
          sock.destroy();
          reject(new Error('ingest gate timeout'));
        }, 2000);
        sock.on('connect', () => {
          sock.write(JSON.stringify({
            v: 1, kind: 'claude-code', event, sessionId, ts: new Date().toISOString(),
          }) + '\n');
        });
        sock.on('data', (c) => {
          buf += c;
          if (!buf.includes('\n')) return;
          clearTimeout(fail);
          sock.end();
          const decision = JSON.parse(buf.trim()) as Record<string, unknown>;
          const stdout = reply === 'permission'
            ? JSON.stringify({ permission: decision.permission ?? 'allow' })
            : JSON.stringify({ continue: decision.continue ?? true });
          resolve({ stdout, stderr: '', status: 0 });
        });
        sock.on('error', reject);
      });

    const r = await post('PermissionRequest', 'permission', 's1');
    assert.match(r.stdout, /deny/);
    const r2 = await post('PreToolUse', 'continue', 's2');
    assert.match(r2.stdout, /"continue":false/);

    const r3 = await hookAsync(
      ['--kind', 'claude-code', '--event', 'PermissionRequest', '--reply', 'permission'],
      JSON.stringify({ session_id: 's3' }),
      adapterHome,
    );
    assert.match(r3.stdout, /deny/, `stdout=${r3.stdout} stderr=${r3.stderr}`);
    const r4 = await hookAsync(
      ['--kind', 'claude-code', '--event', 'PreToolUse', '--reply', 'continue'],
      JSON.stringify({ session_id: 's4' }),
      adapterHome,
    );
    assert.match(r4.stdout, /"continue":false/);

    await active.stop();
    active = new IngestServer(() => {}, () => ({}));
    await active.start();
    const r5 = await hookAsync(
      ['--kind', 'claude-code', '--event', 'PreToolUse', '--reply', 'continue'],
      JSON.stringify({ session_id: 's5' }),
      adapterHome,
    );
    assert.match(r5.stdout, /"continue":true/);
  } finally {
    await active.stop();
  }
});
