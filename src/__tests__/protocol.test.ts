import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, SCHEMA_V, toWireStatus, MAX_PREVIEW_BYTES, AgentStatus } from '../protocol';

test('envelope wraps data with schema version and timestamp', () => {
  const e = envelope('status', { ok: true });
  assert.equal(e.v, SCHEMA_V);
  assert.equal(e.type, 'status');
  assert.deepEqual(e.data, { ok: true });
  assert.ok(e.ts);
});

test('envelope accepts an optional id', () => {
  const e = envelope('ack', { done: true }, 'agent-1');
  assert.equal(e.id, 'agent-1');
});

test('toWireStatus: emits canonical fields, drops internal keys, truncates previews', () => {
  const long = 'x'.repeat(MAX_PREVIEW_BYTES + 50);
  const s: AgentStatus = {
    agentId: 'claude-code:h:s', kind: 'claude-code', host: 'h', sessionId: 's',
    status: 'busy', updatedAt: 1000, startedAt: 900,
    title: 'T', cwd: '/r', branch: 'main', model: 'm', mode: 'default',
    activeTools: [{ name: 'Bash', inputPreview: long, startedAt: 500 }, { name: 'Read' }],
    context: { used: 1, limit: 2 }, cost: { usd: 0.5 },
    waiting: { kind: 'approval', text: long, options: ['yes'] },
    lastReply: long, lastPrompt: long,
  };
  const w = toWireStatus(s) as Record<string, any>;
  // internal-only keys stripped
  assert.equal(w.host, undefined);
  assert.equal(w.sessionId, undefined);
  // required + optional fields present
  assert.equal(w.agentId, 'claude-code:h:s');
  assert.equal(w.status, 'busy');
  assert.equal(w.updatedAt, 1000);
  assert.equal(w.startedAt, 900);
  assert.equal(w.branch, 'main');
  // truncation applied everywhere
  assert.equal((w.activeTools[0].inputPreview as string).length, MAX_PREVIEW_BYTES);
  assert.equal(w.activeTools[0].startedAt, 500);
  assert.equal(w.activeTools[1].name, 'Read');
  assert.equal(w.activeTools[1].inputPreview, undefined);
  assert.equal((w.waiting.text as string).length, MAX_PREVIEW_BYTES);
  assert.equal((w.lastReply as string).length, MAX_PREVIEW_BYTES);
  assert.equal((w.lastPrompt as string).length, MAX_PREVIEW_BYTES);
});

test('toWireStatus: minimal snapshot omits empty/absent optionals', () => {
  const s: AgentStatus = {
    agentId: 'x:h:s', kind: 'x', host: 'h', sessionId: 's', status: 'idle', updatedAt: 5,
    activeTools: [],
  };
  const w = toWireStatus(s) as Record<string, unknown>;
  assert.deepEqual(w, { agentId: 'x:h:s', kind: 'x', status: 'idle', updatedAt: 5 });
});
