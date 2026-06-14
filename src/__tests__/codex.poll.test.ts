import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cx-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not HOME
const sessionsDir = path.join(home, '.codex', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const rolloutPath = (id: string) =>
  path.join(sessionsDir, `rollout-2026-06-11T08-47-00-${id}.jsonl`);

test('codex poll discovers recent rollouts and ends stale sessions', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const id = '11111111-1111-1111-1111-111111111111';
  const file = rolloutPath(id);
  fs.writeFileSync(file, [
    `{"timestamp":"2026-06-11T08:47:00.000Z","type":"session_meta","payload":{"id":"${id}","cwd":"/tmp"}}`,
    `{"timestamp":"2026-06-11T08:47:10.000Z","type":"event_msg","payload":{"type":"user_message","message":"hi","kind":"plain"}}`,
  ].join('\n'));
  try {
    const codex = (await import('../adapters/codex')).default;
    const events: string[] = [];
    const stop = codex.poll!((ev) => events.push(ev.event));
    fs.unlinkSync(file);
    mock.timers.tick(2000);
    stop();
    assert.ok(events.length >= 1, `events: ${events.join(',')}`);
  } finally {
    mock.timers.reset();
  }
});

test('deriveFromRollout approval text variants and turn_context', async () => {
  const { deriveFromRollout } = await import('../adapters/codex');
  const NOW = Date.now();
  const t = (extra: string) => deriveFromRollout(
    `{"timestamp":"2026-06-11T08:47:25.000Z","type":"event_msg","payload":{"type":"exec_approval_request",${extra}}}`,
    NOW, NOW, 'fb',
  )!;
  assert.match(t('"command":["rm","x"]').waitingText!, /rm/);
  assert.match(t('"command":"ls"').waitingText!, /ls/);
  assert.match(t('"message":"please"').waitingText!, /please/);
  const w = deriveFromRollout(
    '{"timestamp":"2026-06-11T08:47:00.000Z","type":"turn_context","payload":{"cwd":"/w","model":"m"}}',
    NOW, NOW, 'fb',
  )!;
  assert.equal(w.cwd, '/w');
  assert.equal(w.model, 'm');
});
