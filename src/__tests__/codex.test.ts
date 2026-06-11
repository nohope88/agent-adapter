import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFromRollout } from '../adapters/codex';

const NOW = Date.parse('2026-06-11T08:47:30.000Z');
const meta = (id: string, cwd = '/Users/tam/Desktop/codex') =>
  `{"timestamp":"2026-06-11T08:47:00.000Z","type":"session_meta","payload":{"id":"${id}","cwd":"${cwd}"}}`;
const userMsg = (ts: string, text: string) =>
  `{"timestamp":"${ts}","type":"event_msg","payload":{"type":"user_message","message":"${text}","kind":"plain"}}`;
const agentMsg = (ts: string, text: string) =>
  `{"timestamp":"${ts}","type":"event_msg","payload":{"type":"agent_message","message":"${text}"}}`;
const approval = (ts: string, cmd: string[]) =>
  `{"timestamp":"${ts}","type":"event_msg","payload":{"type":"exec_approval_request","command":${JSON.stringify(cmd)}}}`;
const callOutput = (ts: string) =>
  `{"timestamp":"${ts}","type":"response_item","payload":{"type":"function_call_output","output":"ok"}}`;

test('completed turn (agent reply newest) → idle, with title + lastResponse', () => {
  const text = [
    meta('s-idle'),
    userMsg('2026-06-11T08:47:10.000Z', 'hi'),
    agentMsg('2026-06-11T08:47:20.000Z', 'Hey! How can I help?'),
  ].join('\n');
  const d = deriveFromRollout(text, NOW - 5_000, NOW, 'fallback')!;
  assert.equal(d.status, 'idle');
  assert.equal(d.sessionId, 's-idle');       // from session_meta, not the fallback
  assert.equal(d.title, 'hi');
  assert.equal(d.cwd, '/Users/tam/Desktop/codex');
  assert.match(d.lastResponse!, /Hey!/);
});

test('user spoke and no reply yet, file fresh → working', () => {
  const text = [meta('s-work'), userMsg('2026-06-11T08:47:25.000Z', 'do a thing')].join('\n');
  const d = deriveFromRollout(text, NOW - 3_000, NOW, 'fallback')!;
  assert.equal(d.status, 'working');
});

test('working turn but file gone stale (>2min, agent likely gone) → idle (no stuck card)', () => {
  const text = [meta('s-stale'), userMsg('2026-06-11T08:47:25.000Z', 'do a thing')].join('\n');
  const d = deriveFromRollout(text, NOW - 200_000, NOW, 'fallback')!;
  assert.equal(d.status, 'idle');
});

test('pending approval request is the newest event → waiting with the command text', () => {
  const text = [
    meta('s-wait'),
    userMsg('2026-06-11T08:47:10.000Z', 'delete it'),
    approval('2026-06-11T08:47:25.000Z', ['rm', '-rf', 'build']),
  ].join('\n');
  const d = deriveFromRollout(text, NOW - 2_000, NOW, 'fallback')!;
  assert.equal(d.status, 'waiting');
  assert.equal(d.waitingText, 'Run: rm -rf build');
});

test('approval followed by tool output + reply → resolved, not waiting', () => {
  const text = [
    meta('s-resolved'),
    userMsg('2026-06-11T08:47:05.000Z', 'delete it'),
    approval('2026-06-11T08:47:10.000Z', ['rm', '-rf', 'build']),
    callOutput('2026-06-11T08:47:15.000Z'),
    agentMsg('2026-06-11T08:47:20.000Z', 'Done.'),
  ].join('\n');
  const d = deriveFromRollout(text, NOW - 2_000, NOW, 'fallback')!;
  assert.equal(d.status, 'idle');
});

test('no session_meta → falls back to the id derived from the filename', () => {
  const text = userMsg('2026-06-11T08:47:20.000Z', 'hi');
  const d = deriveFromRollout(text, NOW - 2_000, NOW, 'uuid-from-filename')!;
  assert.equal(d.sessionId, 'uuid-from-filename');
});

test('a half-written trailing JSON line is tolerated', () => {
  const text = [
    meta('s-partial'),
    agentMsg('2026-06-11T08:47:20.000Z', 'ok'),
    '{"timestamp":"2026-06-11T08:47:30.000Z","type":"event_msg","payl', // truncated
  ].join('\n');
  const d = deriveFromRollout(text, NOW - 2_000, NOW, 'fallback')!;
  assert.equal(d.status, 'idle');
});
