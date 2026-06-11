import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookReturnChannel, decisionFromAnswer } from '../injector/hookReturn';
import { HookEvent } from '../protocol';

const gateEv = (e: Partial<HookEvent>): HookEvent =>
  ({ v: 1, kind: 'claude-code', event: 'PreToolUse', sessionId: 's', ...e } as HookEvent);

test('stage → has → gateFor consumes the decision', () => {
  const h = new HookReturnChannel();
  h.stage('s', { permission: 'allow' });
  assert.ok(h.has('s'));
  const d = h.gateFor(gateEv({}));
  assert.equal(d?.permission, 'allow');
  assert.equal(h.has('s'), false); // consumed once
});

test('gateFor ignores non-gate events', () => {
  const h = new HookReturnChannel();
  h.stage('s', { permission: 'allow' });
  const d = h.gateFor(gateEv({ event: 'Stop' }));
  assert.equal(d, null);
  assert.ok(h.has('s')); // still staged
});

test('expired stage is not returned', () => {
  const h = new HookReturnChannel();
  h.stage('s', { permission: 'allow' }, -1); // already expired
  assert.equal(h.has('s'), false);
  assert.equal(h.gateFor(gateEv({})), null);
});

test('decisionFromAnswer maps yes/no to allow/deny', () => {
  assert.equal(decisionFromAnswer('yes').permission, 'allow');
  assert.equal(decisionFromAnswer('allow').permission, 'allow');
  assert.equal(decisionFromAnswer('no').permission, 'deny');
  assert.equal(decisionFromAnswer('whatever').permission, 'deny');
});
