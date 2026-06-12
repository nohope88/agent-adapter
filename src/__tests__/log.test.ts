import { test } from 'node:test';
import assert from 'node:assert/strict';

test('logger emits debug when threshold allows', async () => {
  process.env.AGENT_ADAPTER_LOG = 'debug';
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { chunks.push(s); return true; }) as typeof process.stdout.write;
  try {
    const { logger } = await import('../util/log');
    logger('t').debug('dbg', { x: 1 });
    assert.ok(chunks.some((c) => c.includes('DEBUG') && c.includes('[t]')));
  } finally {
    process.stdout.write = orig;
    delete process.env.AGENT_ADAPTER_LOG;
  }
});

test('logger safe() falls back to String() on a non-serializable extra', async () => {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => { chunks.push(s); return true; }) as typeof process.stderr.write;
  try {
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws → safe() returns String(v)
    const { logger } = await import('../util/log');
    logger('t').error('boom', circular);
    assert.ok(chunks.some((c) => c.includes('[object Object]')));
  } finally {
    process.stderr.write = orig;
  }
});
