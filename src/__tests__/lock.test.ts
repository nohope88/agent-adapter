import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-lock-'));
process.env.AGENT_ADAPTER_HOME = path.join(home, '.agent-adapter');

test('acquireSingleInstance writes pidfile and release removes it', async () => {
  const { acquireSingleInstance } = await import('../util/lock');
  const { PATHS } = await import('../util/paths');
  const release = acquireSingleInstance();
  assert.equal(fs.readFileSync(PATHS.pidfile, 'utf8').trim(), String(process.pid));
  release();
  assert.equal(fs.existsSync(PATHS.pidfile), false);
});

test('acquireSingleInstance replaces stale pidfile from dead process', async () => {
  const { acquireSingleInstance } = await import('../util/lock');
  const { PATHS } = await import('../util/paths');
  fs.mkdirSync(path.dirname(PATHS.pidfile), { recursive: true });
  fs.writeFileSync(PATHS.pidfile, '999999999');
  const release = acquireSingleInstance();
  assert.equal(fs.readFileSync(PATHS.pidfile, 'utf8').trim(), String(process.pid));
  release();
});
