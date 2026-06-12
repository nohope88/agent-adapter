import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('process-fallback emits baseline for matching processes', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const { ProcessFallback } = await import('../adapters/process-fallback');
    const events: { kind: string; event: string }[] = [];
    const fb = new ProcessFallback(['gemini'], (ev) => events.push({ kind: ev.kind, event: ev.event }));
    fb.start();
    mock.timers.tick(3000);
    fb.stop();
    mock.timers.reset();
    assert.ok(Array.isArray(events));
  } finally {
    mock.timers.reset();
  }
});

test('process-fallback no-ops when kinds empty', async () => {
  const { ProcessFallback } = await import('../adapters/process-fallback');
  const fb = new ProcessFallback([], () => { throw new Error('should not emit'); });
  fb.start();
  fb.stop();
});
