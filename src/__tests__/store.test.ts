import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../store';
import { HookEvent } from '../protocol';

const ev = (e: Partial<HookEvent>): HookEvent =>
  ({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 's', ...e } as HookEvent);

test('apply emits on first event, returns null when nothing visible changed', () => {
  const st = new SessionStore();
  const a = st.apply(ev({ event: 'PreToolUse', tool: 'Bash' }));
  assert.ok(a, 'first event should emit');
  const b = st.apply(ev({ event: 'PreToolUse', tool: 'Bash' }));
  assert.equal(b, null, 'identical working+tool should be throttled');
});

test('a visible change (status) re-emits', () => {
  const st = new SessionStore();
  st.apply(ev({ event: 'PreToolUse', tool: 'Bash' }));   // working
  const c = st.apply(ev({ event: 'Stop' }));             // idle
  assert.ok(c);
  assert.equal(c!.status, 'idle');
});

test('roster sorts waiting first', () => {
  const st = new SessionStore();
  st.apply(ev({ sessionId: 'w', event: 'SessionStart' }));               // idle
  st.apply(ev({ sessionId: 'x', event: 'PermissionRequest', message: '?' })); // waiting
  assert.equal(st.roster()[0].sessionId, 'x');
});

test('onChange listener fires on emit', () => {
  const st = new SessionStore();
  let n = 0;
  st.onChange(() => n++);
  st.apply(ev({ event: 'PreToolUse', tool: 'Bash' }));
  assert.equal(n, 1);
});

test('drops events missing sessionId/kind', () => {
  const st = new SessionStore();
  assert.equal(st.apply({ v: 1, event: 'SessionStart' } as HookEvent), null);
});

test('get, byAgentId, and prune mark ended then drop', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const st = new SessionStore({ staleMs: 1000 });
    st.apply(ev({ sessionId: 'p', event: 'SessionStart' }));
    assert.ok(st.get('p'));
    assert.ok(st.byAgentId(st.get('p')!.agentId));
    assert.equal(st.byAgentId('no-such-agent'), undefined);
    st.startPrune();
    mock.timers.setTime(Date.now() + 61_000);
    mock.timers.tick(60_000);
    st.stopPrune();
    assert.equal(st.roster().length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('get returns a session snapshot', () => {
  const st = new SessionStore();
  st.apply(ev({ event: 'SessionStart', title: 'hello' }));
  assert.equal(st.get('s')?.title, 'hello');
});

test('onChange unsubscribe stops notifications', () => {
  const st = new SessionStore();
  let n = 0;
  const off = st.onChange(() => n++);
  st.apply(ev({ event: 'PreToolUse', tool: 'Bash' }));
  off();
  st.apply(ev({ event: 'Stop' }));
  assert.equal(n, 1);
});
