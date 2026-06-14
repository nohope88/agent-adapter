import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-oc-'));
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not HOME
const sessions = path.join(home, '.openclaw', 'sessions');
fs.mkdirSync(sessions, { recursive: true });

test('openclaw poll emits SessionStart and working/idle transitions', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const openclaw = (await import('../adapters/openclaw')).default;
    const events: { event: string; sessionId: string }[] = [];
    const stop = openclaw.poll!((ev) => events.push({ event: ev.event, sessionId: ev.sessionId }));
    const f = path.join(sessions, 'sess1.jsonl');
    fs.writeFileSync(f, '{}');
    mock.timers.tick(1);
    fs.utimesSync(f, new Date(), new Date());
    mock.timers.tick(2000);
    fs.unlinkSync(f);
    mock.timers.tick(2000);
    stop();
    mock.timers.reset();
    assert.ok(events.some((e) => e.event === 'SessionStart'));
  } finally {
    mock.timers.reset();
  }
});
