import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { stopCommand } from '../hooks/installer-daemon';

test('stopCommand: per-platform service-manager command', () => {
  const mac = stopCommand('darwin');
  assert.equal(mac?.cmd, 'launchctl');
  assert.deepEqual(mac?.args.slice(0, 1), ['unload']);
  assert.ok(mac?.target.endsWith('com.agent-adapter.plist'));

  const linux = stopCommand('linux');
  assert.equal(linux?.cmd, 'systemctl');
  assert.deepEqual(linux?.args, ['--user', 'stop', 'agent-adapter.service']);

  const win = stopCommand('win32');
  assert.equal(win?.cmd, 'schtasks');
  assert.deepEqual(win?.args, ['/End', '/TN', 'AgentAdapter']);

  assert.equal(stopCommand('freebsd' as NodeJS.Platform), null);
});

async function withMain(argv: string[]): Promise<string> {
  const origArgv = process.argv;
  const origOut = process.stdout.write.bind(process.stdout);
  let out = '';
  process.argv = ['node', 'cli.js', ...argv];
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  try {
    const { main } = await import('../cli');
    await main();
  } finally {
    process.argv = origArgv;
    process.stdout.write = origOut;
  }
  return out;
}

test('cli stop: dispatches and reports the stopped service', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-stop-'));
  process.env.HOME = home;
  process.env.AGENT_ADAPTER_HOME = path.join(home, '.aa');
  process.env.AGENT_ADAPTER_SKIP_DAEMON = '1'; // don't shell out to the real service manager

  const out = await withMain(['stop']);
  assert.ok(/Adapter service stopped/.test(out), out);
});
