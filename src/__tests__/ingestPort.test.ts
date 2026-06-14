import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Isolate state BEFORE util/paths loads (it reads env at import time).
process.env.AGENT_ADAPTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-iport-'));

test('ingest-port discovery: read / write / clear', async () => {
  const { PATHS, readIngestPort, writeIngestPort, clearIngestPort } = await import('../util/paths');

  // no file yet → clear is a no-op (catch), read falls back to the default port
  clearIngestPort();
  assert.equal(fs.existsSync(PATHS.ingestPortFile), false);
  assert.equal(readIngestPort(), PATHS.ingestTcpPort);

  // published file → read returns it
  writeIngestPort(49231);
  assert.equal(fs.readFileSync(PATHS.ingestPortFile, 'utf8'), '49231');
  assert.equal(readIngestPort(), 49231);

  // garbage content → fall back to the default port
  fs.writeFileSync(PATHS.ingestPortFile, 'not-a-port');
  assert.equal(readIngestPort(), PATHS.ingestTcpPort);

  // clear removes it; a second clear is harmless
  clearIngestPort();
  assert.equal(fs.existsSync(PATHS.ingestPortFile), false);
  clearIngestPort();
});
