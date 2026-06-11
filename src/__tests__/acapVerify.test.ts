import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAll, verify } from '../acapVerify';
import { AdapterDescriptor } from '../adapters/types';

test('all bundled adapters pass acap-verify', () => {
  for (const r of verifyAll()) {
    assert.ok(r.pass, `${r.kind} failed: ${r.problems.join('; ')}`);
  }
});

test('a malformed descriptor fails with problems', () => {
  const bad = {
    kind: 'x',
    level: 'L9',
    capabilities: ['nope'],
    provides: [],
    inject: { channel: 'bad', hookReturn: false },
    detectDir: '',
  } as unknown as AdapterDescriptor;
  const r = verify(bad);
  assert.equal(r.pass, false);
  assert.ok(r.problems.length >= 3);
});

test('declaring capabilities with no inject path fails', () => {
  const d = {
    kind: 'y', level: 'L1', capabilities: ['prompt'], provides: ['status'],
    inject: { channel: 'none', hookReturn: false }, detectDir: '/tmp',
  } as unknown as AdapterDescriptor;
  const r = verify(d);
  assert.equal(r.pass, false);
});
