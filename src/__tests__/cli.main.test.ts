import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

async function withMain(argv: string[]): Promise<{ out: string; err: string; exitCode?: number }> {
  const origArgv = process.argv;
  const origExit = process.exit;
  const origStdin = process.stdin;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  let exitCode: number | undefined;
  process.argv = ['node', 'cli.js', ...argv];
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`exit:${exitCode}`); }) as typeof process.exit;
  Object.assign(process.stdin, Readable.from(['{}']));
  try {
    const { main } = await import('../cli');
    await main();
  } catch (e) {
    if (!String(e).startsWith('Error: exit:')) throw e;
  } finally {
    process.argv = origArgv;
    process.exit = origExit;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    Object.assign(process.stdin, origStdin);
  }
  return { out, err, exitCode };
}

test('cli main: hook, help, detect, login, interrupt usage, unknown', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cmain-'));
  process.env.HOME = home;
  process.env.AGENT_ADAPTER_HOME = path.join(home, '.aa');
  process.env.AGENT_ADAPTER_SKIP_DAEMON = '1';

  const hook = await withMain(['hook', '--kind', 'claude-code', '--event', 'Stop', '--reply', 'none']);
  assert.equal(hook.exitCode, undefined);

  const help = await withMain(['help']);
  assert.ok(help.out.includes('agent-adapter'));

  const detect = await withMain(['detect']);
  assert.ok(detect.out.includes('claude-code'));

  const login = await withMain(['login']);
  assert.ok(login.out.includes('tenant API key'));

  const tok = await withMain(['login', '--token', 't', '--commander', 'wss://x']);
  assert.ok(tok.out.includes('Credential saved'));

  const intr = await withMain(['interrupt']);
  assert.equal(intr.exitCode, 2);

  const unk = await withMain(['bogus']);
  assert.equal(unk.exitCode, 2);
});

test('cli main: install and uninstall', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cmain2-'));
  process.env.HOME = home;
  process.env.AGENT_ADAPTER_HOME = path.join(home, '.aa');
  process.env.AGENT_ADAPTER_SKIP_DAEMON = '1';
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  const ins = await withMain(['install']);
  assert.ok(ins.out.includes('Wired hooks'));

  const un = await withMain(['uninstall']);
  assert.ok(un.out.includes('Hooks removed'));
});
