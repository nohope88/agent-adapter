import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';

// Isolate state + port BEFORE anything loads util/paths (which reads env at load).
process.env.AGENT_ADAPTER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-'));
process.env.AGENT_ADAPTER_CONTROL_PORT = '7811';
const PORT = 7811;
const HOST = os.hostname().split('.')[0];

test('hub: ingest → roster(waiting) → answer rejects(no-target) → capability gate', async () => {
  const { Hub } = await import('../hub'); // lazy so env is applied first
  const hub = new Hub({});
  await hub.start();
  try {
    // 1. inject a waiting claude-code session over the test /ingest endpoint
    const ing = await fetch(`http://127.0.0.1:${PORT}/ingest`, {
      method: 'POST',
      body: JSON.stringify({
        v: 1, kind: 'claude-code', event: 'PreToolUse', sessionId: 's1', cwd: '/tmp/r',
        tool: 'AskUserQuestion', toolInput: { question: 'Run tests?', options: ['yes', 'no'] },
        title: 'demo',
      }),
    });
    assert.equal(ing.status, 200);

    // 2. roster shows it as waiting
    const roster = (await (await fetch(`http://127.0.0.1:${PORT}/agents`)).json()) as Array<Record<string, unknown>>;
    const mine = roster.find((s) => s.sessionId === 's1');
    assert.ok(mine, 'session should be in roster');
    assert.equal(mine!.status, 'waiting');

    // 3. answering rejects cleanly (no real terminal bound) — must NOT crash
    const ack = (await (await fetch(`http://127.0.0.1:${PORT}/command`, {
      method: 'POST',
      body: JSON.stringify({ agentId: `claude-code:${HOST}:s1`, intent: 'answer', answer: 'yes' }),
    })).json()) as { status: string; detail?: string };
    assert.equal(ack.status, 'rejected');

    // 4. capability gate: claude-code does not support 'mode'
    const gate = (await (await fetch(`http://127.0.0.1:${PORT}/command`, {
      method: 'POST',
      body: JSON.stringify({ agentId: `claude-code:${HOST}:s1`, intent: 'mode', mode: 'plan' }),
    })).json()) as { status: string; detail?: string };
    assert.equal(gate.status, 'rejected');
    assert.match(String(gate.detail), /not supported/);

    // 5. healthz
    const health = (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()) as { ok: boolean };
    assert.equal(health.ok, true);
  } finally {
    await hub.stop();
    try { fs.rmSync(process.env.AGENT_ADAPTER_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
