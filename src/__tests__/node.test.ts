import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableNode } from '../util/node';

test('stableNode: a packaged aca binary is returned as-is', () => {
  assert.equal(stableNode('/opt/aca', () => { throw new Error('unused'); }), '/opt/aca');
});

test('stableNode: returns the stable symlink that resolves to the running node', () => {
  const got = stableNode('/real/node', (c) => (c === '/cand/node' ? '/real/node' : c), ['/miss/node', '/cand/node']);
  assert.equal(got, '/cand/node');
});

test('stableNode: missing candidates (realpath throws) fall back to exec', () => {
  const got = stableNode('/real/node', () => { throw new Error('ENOENT'); }, ['/a/node', '/b/node']);
  assert.equal(got, '/real/node');
});

test('stableNode: no candidate resolves to exec → falls back to exec', () => {
  const got = stableNode('/real/node', (c) => c, ['/x/node', '/y/node']);
  assert.equal(got, '/real/node');
});
