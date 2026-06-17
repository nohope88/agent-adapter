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

test('UserPromptSubmit → busy and clears waiting', () => {
  let s = reduce(undefined, ev({ event: 'PermissionRequest', message: '?' }));
  assert.equal(s.status, 'waiting');
  s = reduce(s, ev({ event: 'UserPromptSubmit' }));
  assert.equal(s.status, 'busy');
  assert.equal(s.waiting, undefined);
});

test('PreToolUse AskUserQuestion → waiting with question + options', () => {
  const s = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskUserQuestion',
    toolInput: { question: 'Run tests?', options: ['yes', 'no'] },
  }));
  assert.equal(s.status, 'waiting');
  assert.equal(s.waiting?.kind, 'choice');
  assert.equal(s.waiting?.text, 'Run tests?');
  assert.deepEqual(s.waiting?.options, ['yes', 'no']);
});

test('PreToolUse normal tool → busy with activeTools', () => {
  const s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'ls' } }));
  assert.equal(s.status, 'busy');
  assert.equal(s.activeTools?.[0]?.name, 'Bash');
  assert.equal(typeof s.activeTools?.[0]?.startedAt, 'number');
});

test('Stop → idle and keeps lastReply', () => {
  const s = reduce(undefined, ev({ event: 'Stop', lastResponse: 'done' }));
  assert.equal(s.status, 'idle');
  assert.equal(s.lastReply, 'done');
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

test('status priority waiting > busy > idle > ended', () => {
  assert.ok(statusPriority('waiting') > statusPriority('busy'));
  assert.ok(statusPriority('busy') > statusPriority('idle'));
  assert.ok(statusPriority('idle') > statusPriority('ended'));
});

test('agentIdOf is kind:host:sessionId', () => {
  assert.match(agentIdOf('claude-code', 'abc'), /^claude-code:.+:abc$/);
});

test('PermissionRequest → waiting with default options', () => {
  const s = reduce(undefined, ev({ event: 'PermissionRequest', tool: 'Bash' }));
  assert.equal(s.status, 'waiting');
  assert.equal(s.waiting?.kind, 'approval');
  assert.deepEqual(s.waiting?.options, ['yes', 'no']);
});

test('Notification → waiting input banner', () => {
  const s = reduce(undefined, ev({ event: 'Notification', message: 'need input' }));
  assert.equal(s.status, 'waiting');
  assert.equal(s.waiting?.kind, 'input');
  assert.equal(s.waiting?.text, 'need input');
});

test('PostToolUse clears activeTools', () => {
  let s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { command: 'ls -la' } }));
  s = reduce(s, ev({ event: 'PostToolUse' }));
  assert.equal(s.status, 'busy');
  assert.equal(s.activeTools, undefined);
});

test('waitingFromTool maps object options and preview fallbacks', () => {
  const s = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskQuestion',
    toolInput: { question: 'Q?', options: [{ label: 'a' }, 'b'] },
  }));
  assert.deepEqual(s.waiting?.options, ['a', 'b']);
  const p = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { description: 'run' } }));
  assert.equal(p.activeTools?.[0]?.inputPreview, 'run');
  const j = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { nested: { a: 1 } } }));
  assert.ok(j.activeTools?.[0]?.inputPreview);
});

test('previewOf returns undefined for null toolInput', () => {
  const s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: null }));
  assert.equal(s.activeTools?.[0]?.inputPreview, undefined);
});

test('previewOf handles string input and empty options on Notification', () => {
  const s = reduce(undefined, ev({ event: 'Notification', message: 'x', options: [] }));
  assert.equal(s.waiting?.options.length, 0);
});

test('AskUserQuestion questions[] schema → question text + flattened option labels', () => {
  const s = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskUserQuestion',
    toolInput: {
      questions: [
        { question: 'Chế độ?', header: 'Chế độ', options: [{ label: '2 người' }, { label: 'AI' }] },
        { question: 'Luật?', options: ['Chuẩn'] },
      ],
    },
  }));
  assert.equal(s.status, 'waiting');
  assert.equal(s.waiting?.kind, 'choice');
  assert.equal(s.waiting?.text, 'Chế độ? · Luật?');
  assert.deepEqual(s.waiting?.options, ['2 người', 'AI', 'Chuẩn']);
});

test('AskUserQuestion questions[] falls back to header, then to tool text; missing options → []', () => {
  const h = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskUserQuestion',
    toolInput: { questions: [{ header: 'Nền tảng', options: [] }] },
  }));
  assert.equal(h.waiting?.text, 'Nền tảng');
  assert.deepEqual(h.waiting?.options, []);

  const t = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskUserQuestion',
    toolInput: { questions: [{}] },
  }));
  assert.equal(t.waiting?.text, 'AskUserQuestion needs an answer');
  assert.deepEqual(t.waiting?.options, []);
});

test('Notification does not clobber a richer AskUserQuestion waiting', () => {
  let s = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Mode?', options: [{ label: 'A' }, { label: 'B' }] }] },
  }));
  assert.deepEqual(s.waiting?.options, ['A', 'B']);
  // A generic notification arriving while the choice is open keeps the choice.
  s = reduce(s, ev({ event: 'Notification', message: 'Claude needs your permission' }));
  assert.equal(s.status, 'waiting');
  assert.equal(s.waiting?.text, 'Mode?');
  assert.deepEqual(s.waiting?.options, ['A', 'B']);
});

test('Notification with its own options still updates the banner', () => {
  let s = reduce(undefined, ev({
    event: 'PreToolUse', tool: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Mode?', options: [{ label: 'A' }] }] },
  }));
  s = reduce(s, ev({ event: 'Notification', message: 'pick', options: ['x', 'y'] }));
  assert.equal(s.waiting?.text, 'pick');
  assert.deepEqual(s.waiting?.options, ['x', 'y']);
});

test('previewOf returns undefined when toolInput is not JSON-serializable', () => {
  // BigInt makes JSON.stringify throw → the catch returns undefined.
  const s = reduce(undefined, ev({ event: 'PreToolUse', tool: 'Bash', toolInput: { big: 10n } as never }));
  assert.equal(s.activeTools?.[0]?.inputPreview, undefined);
});
