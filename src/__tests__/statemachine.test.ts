import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, statusPriority, agentIdOf } from '../statemachine';
import { HookEvent } from '../protocol';

const ev = (e: Partial<HookEvent>): HookEvent =>
  ({ v: 1, kind: 'claude-code', event: 'SessionStart', sessionId: 's', ...e } as HookEvent);

test('SessionStart → idle', () => {
  const s = reduce(undefined, ev({ event: 'SessionStart' }));
  assert.equal(s.status, 'idle');
  assert.equal(s.sessionId, 's');
});

test('UserPromptSubmit → working and clears waiting', () => {
  let s = reduce(undefined, ev({ event: 'PermissionRequest', message: '?' }));
  assert.equal(s.status, 'waiting');
  s = reduce(s, ev({ event: 'UserPromptSubmit' }));
  assert.equal(s.status, 'working');
  assert.equal(s.waiting, undefined);
});

test('PreToolUse AskUserQuestion → waiting with question + options', () => {
  const s = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskUserQuestion',
    toolInput: { question: 'Run tests?', options: ['yes', 'no'] },
  }));
  assert.equal(s.status, 'waiting');
  assert.equal(s.waiting?.text, 'Run tests?');
  assert.deepEqual(s.waiting?.options, ['yes', 'no']);
});

test('PreToolUse normal tool → working with activeTool', () => {
  const s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'ls' } }));
  assert.equal(s.status, 'working');
  assert.equal(s.activeTool?.name, 'Bash');
});

test('Stop → idle and keeps lastResponse', () => {
  const s = reduce(undefined, ev({ event: 'Stop', lastResponse: 'done' }));
  assert.equal(s.status, 'idle');
  assert.equal(s.lastResponse, 'done');
});

test('SessionEnd → ended', () => {
  assert.equal(reduce(undefined, ev({ event: 'SessionEnd' })).status, 'ended');
});

// ── oc-claw pitfall #2: source is upgrade-only ──────────────────
test('source upgrade-only: cursor wins, cc cannot downgrade it', () => {
  let s = reduce(undefined, ev({ kind: 'claude-code', event: 'PreToolUse', tool: 'Bash', source: 'cursor' }));
  assert.equal(s.kind, 'cursor');
  s = reduce(s, ev({ kind: 'claude-code', event: 'PostToolUse', source: 'claude-code' }));
  assert.equal(s.kind, 'cursor');
});

// ── oc-claw pitfall #3: empty field must not overwrite ──────────
test('empty incoming field does not overwrite a real value', () => {
  let s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', cwd: '/repo' }));
  assert.equal(s.cwd, '/repo');
  s = reduce(s, ev({ event: 'PostToolUse', cwd: '' }));
  assert.equal(s.cwd, '/repo');
});

test('status priority waiting > working > idle > ended', () => {
  assert.ok(statusPriority('waiting') > statusPriority('working'));
  assert.ok(statusPriority('working') > statusPriority('idle'));
  assert.ok(statusPriority('idle') > statusPriority('ended'));
});

test('agentIdOf is kind:host:sessionId', () => {
  assert.match(agentIdOf('claude-code', 'abc'), /^claude-code:.+:abc$/);
});

test('PermissionRequest → waiting with default options', () => {
  const s = reduce(undefined, ev({ event: 'PermissionRequest', tool: 'Bash' }));
  assert.equal(s.status, 'waiting');
  assert.deepEqual(s.waiting?.options, ['yes', 'no']);
});

test('Notification → waiting input banner', () => {
  const s = reduce(undefined, ev({ event: 'Notification', message: 'need input' }));
  assert.equal(s.status, 'waiting');
  assert.equal(s.waiting?.text, 'need input');
});

test('PostToolUse clears activeTool', () => {
  let s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'ls -la' } }));
  s = reduce(s, ev({ event: 'PostToolUse' }));
  assert.equal(s.status, 'working');
  assert.equal(s.activeTool, undefined);
});

test('waitingFromTool maps object options and preview fallbacks', () => {
  const s = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskQuestion',
    toolInput: { question: 'Q?', options: [{ label: 'a' }, 'b'] },
  }));
  assert.deepEqual(s.waiting?.options, ['a', 'b']);
  const p = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { description: 'run' } }));
  assert.equal(p.activeTool?.preview, 'run');
  const j = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { nested: { a: 1 } } }));
  assert.ok(j.activeTool?.preview);
});

test('previewOf returns undefined for null toolInput', () => {
  const s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: null }));
  assert.equal(s.activeTool?.preview, undefined);
});

test('previewOf handles string input and empty options on Notification', () => {
  const s = reduce(undefined, ev({ event: 'Notification', message: 'x', options: [] }));
  assert.equal(s.waiting?.options.length, 0);
});

test('previewOf returns undefined when toolInput is not JSON-serializable', () => {
  // BigInt makes JSON.stringify throw → the catch returns undefined.
  const s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { big: 10n } as never }));
  assert.equal(s.activeTool?.preview, undefined);
});
