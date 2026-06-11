import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BindingMap } from '../binding';
import { HookEvent } from '../protocol';

const ev = (e: Partial<HookEvent>): HookEvent =>
  ({ v: 1, kind: 'claude-code', event: 'PreToolUse', sessionId: 's', ...e } as HookEvent);

test('non-cursor pid is recorded as an inject target', () => {
  const b = new BindingMap();
  b.learn(ev({ pid: 123, cwd: '/repo' }));
  const t = b.resolve('s');
  assert.equal(t?.pid, 123);
  assert.equal(t?.cwd, '/repo');
});

test('cursor pid is ignored (oc-claw pitfall #1); native handle kept', () => {
  const b = new BindingMap();
  b.learn(ev({ kind: 'cursor', pid: 999, nativeHandle: 'abc', cursorPort: 23456 } as Partial<HookEvent>));
  const t = b.resolve('s');
  assert.equal(t?.pid, undefined);
  assert.equal(t?.nativeHandle, 'abc');
  assert.equal(t?.cursorPort, 23456);
});

test('forget removes the binding', () => {
  const b = new BindingMap();
  b.learn(ev({ pid: 1 }));
  b.forget('s');
  assert.equal(b.resolve('s'), undefined);
});
