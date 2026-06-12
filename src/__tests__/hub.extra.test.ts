import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hubx-'));
process.env.AGENT_ADAPTER_HOME = path.join(home, '.agent-adapter');
process.env.AGENT_ADAPTER_CONTROL_PORT = '7814';
const PORT = 7814;

test('hub: SSE stream, 404, bad bodies, unknown kind', async () => {
  const { Hub } = await import('../hub');
  const hub = new Hub({ local: true });
  await hub.start();
  try {
    const sse = await fetch(`http://127.0.0.1:${PORT}/stream`);
    const reader = sse.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value!);
    await reader.cancel();
    assert.match(chunk, /event: roster/);

    assert.equal((await fetch(`http://127.0.0.1:${PORT}/nope`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/command`, { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/command`, {
      method: 'POST', body: JSON.stringify({ intent: 'prompt' }),
    })).status, 400);

    const unk = await (await fetch(`http://127.0.0.1:${PORT}/command`, {
      method: 'POST',
      body: JSON.stringify({ agentId: 'nope:host:s', intent: 'prompt', prompt: 'x' }),
    })).json() as { status: string };
    assert.equal(unk.status, 'rejected');

    await fetch(`http://127.0.0.1:${PORT}/ingest`, { method: 'POST', body: '{' });
    const reader2 = (await fetch(`http://127.0.0.1:${PORT}/stream`)).body!.getReader();
    await reader2.read();
    await fetch(`http://127.0.0.1:${PORT}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ v: 1, kind: 'claude-code', event: 'UserPromptSubmit', sessionId: 'b1', title: 'x' }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const { value: v2 } = await reader2.read();
    const statusChunk = new TextDecoder().decode(v2!);
    await reader2.cancel();
    assert.match(statusChunk, /event: status/);

    await fetch(`http://127.0.0.1:${PORT}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ v: 1, kind: 'claude-code', event: 'UserPromptSubmit', sessionId: 'b2', title: 'y' }),
    });
  } finally {
    await hub.stop();
  }
});

test('hub: SSE broadcast drops a client whose write throws', async () => {
  const { Hub } = await import('../hub');
  const hub = new Hub({ local: true });
  await hub.start();
  try {
    const sse = (hub as unknown as { sse: Set<{ write(s: string): void }> }).sse;
    const bad = { write() { throw new Error('socket gone'); } };
    sse.add(bad);
    await fetch(`http://127.0.0.1:${PORT}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ v: 1, kind: 'claude-code', event: 'UserPromptSubmit', sessionId: 'sse-throw', title: 'z' }),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sse.has(bad), false, 'a throwing SSE client is removed on broadcast');
  } finally {
    await hub.stop();
  }
});
