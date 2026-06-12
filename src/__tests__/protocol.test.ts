import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelope, SCHEMA_V } from '../protocol';

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
