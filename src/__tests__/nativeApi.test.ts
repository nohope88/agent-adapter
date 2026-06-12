import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { nativeSend } from '../injector/nativeApi';
import { InjectTarget } from '../binding';
import { Command, SCHEMA_V } from '../protocol';

const tgt = (over: Partial<InjectTarget> & { sessionId: string }): InjectTarget => ({
  kind: 'openclaw', updatedAt: 0, ...over,
});
const c = (intent: Command['intent'], extra: Partial<Command> = {}): Command => ({
  v: SCHEMA_V, cmdId: '1', ts: '', agentId: 'a', source: 't', intent, ...extra,
});

test('nativeSend rejects without controlEndpoint', async () => {
  await assert.rejects(() => nativeSend(tgt({ sessionId: 's' }), c('prompt')), /no controlEndpoint/);
});

test('nativeSend posts JSON and surfaces HTTP errors', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500); res.end('fail');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await assert.rejects(
    () => nativeSend(tgt({ sessionId: 's', controlEndpoint: `http://127.0.0.1:${port}/x` }), c('answer', { answer: 'yes' })),
    /500/,
  );
  server.close();
});

test('nativeSend resolves body on success', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('done'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const body = await nativeSend(
    tgt({ sessionId: 's', controlEndpoint: `http://127.0.0.1:${port}/x` }),
    c('interrupt'),
  );
  assert.equal(body, 'done');
  server.close();
});
