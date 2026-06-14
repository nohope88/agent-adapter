import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ingest-'));
process.env.AGENT_ADAPTER_HOME = path.join(home, '.agent-adapter');

type Dial = [string] | [number, string];

function send(dial: Dial, line: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const sock = dial.length === 1 ? net.connect(dial[0]) : net.connect(dial[0], dial[1]);
    let buf = '';
    const done = (v: string | null) => { try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    const t = setTimeout(() => done(buf.trim() || null), 500);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(line + '\n'));
    sock.on('data', (c) => { buf += c; if (buf.includes('\n')) { clearTimeout(t); done(buf.trim()); } });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.on('close', () => { clearTimeout(t); done(buf.trim() || null); });
  });
}

/** Where a client should connect: unix socket on POSIX, the server's published
 *  (ephemeral) TCP port on Windows. */
function dial(p: { ingestSock: string }, isWin: boolean, port: () => number): Dial {
  return isWin ? [port(), '127.0.0.1'] : [p.ingestSock];
}

test('ingest: accepts events, returns gate decision, tolerates bad input', async () => {
  const { IngestServer } = await import('../ingest');
  const { PATHS, isWindows, readIngestPort } = await import('../util/paths');
  const events: unknown[] = [];
  const srv = new IngestServer(
    (ev) => { events.push(ev); },
    (ev) => (ev.event === 'PermissionRequest' ? { permission: 'deny' } : null),
  );
  await srv.start();
  // Resolve the endpoint AFTER start(): on Windows the port is only published
  // once the server has bound its ephemeral port.
  const to = dial(PATHS, isWindows, readIngestPort);
  try {
    const reply = await send(to, JSON.stringify({
      v: 1, kind: 'claude-code', event: 'PermissionRequest', sessionId: 's1', message: 'ok?',
    }));
    assert.match(reply || '', /deny/);
    assert.equal((events[0] as { sessionId: string }).sessionId, 's1');

    await send(to, 'not-json');
    await send(to, JSON.stringify({ event: 'Stop' }));
    assert.equal(events.length, 1);
  } finally {
    await srv.stop();
  }
});

test('ingest: gate throw and onEvent throw are logged, not fatal', async () => {
  const { IngestServer } = await import('../ingest');
  const { PATHS, isWindows, readIngestPort } = await import('../util/paths');
  const srv = new IngestServer(
    () => { throw new Error('boom'); },
    () => { throw new Error('gate-boom'); },
  );
  await srv.start();
  try {
    await send(dial(PATHS, isWindows, readIngestPort), JSON.stringify({
      v: 1, kind: 'x', event: 'SessionStart', sessionId: 's',
    }));
  } finally {
    await srv.stop();
  }
});
