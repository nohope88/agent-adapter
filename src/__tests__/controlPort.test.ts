import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate state BEFORE util/paths loads (it reads env at import time).
process.env.AGENT_ADAPTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cport-'));

test('control-port discovery: read / write / clear', async () => {
  const { PATHS, readControlPort, writeControlPort, clearControlPort } = await import('../util/paths');

  // no file yet → clear is a no-op (catch), read falls back to the preferred port
  clearControlPort();
  assert.equal(fs.existsSync(PATHS.controlPortFile), false);
  assert.equal(readControlPort(), PATHS.controlPort);

  // published file → read returns it
  writeControlPort(54321);
  assert.equal(fs.readFileSync(PATHS.controlPortFile, 'utf8'), '54321');
  assert.equal(readControlPort(), 54321);

  // garbage content → fall back to the preferred port
  fs.writeFileSync(PATHS.controlPortFile, 'not-a-port');
  assert.equal(readControlPort(), PATHS.controlPort);

  // clear removes it; a second clear is harmless
  clearControlPort();
  assert.equal(fs.existsSync(PATHS.controlPortFile), false);
  clearControlPort();
});
