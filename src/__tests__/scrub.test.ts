import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, scrubEnabled, redactPreview } from '../util/scrub';
import { toWireStatus, AgentStatus } from '../protocol';

const ENV = 'AGENT_ADAPTER_SCRUB_SECRETS';
function withScrub(on: boolean, fn: () => void): void {
  const prev = process.env[ENV];
  if (on) process.env[ENV] = '1'; else delete process.env[ENV];
  try { fn(); } finally {
    if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
  }
}

test('scrubEnabled: off by default, on for truthy values', () => {
  withScrub(false, () => assert.equal(scrubEnabled(), false));
  for (const v of ['1', 'true', 'YES', 'on']) {
    process.env[ENV] = v;
    assert.equal(scrubEnabled(), true, `expected ${v} to enable`);
  }
  process.env[ENV] = 'nope';
  assert.equal(scrubEnabled(), false);
  delete process.env[ENV];
});

test('scrub: redacts every known secret shape, keeps surrounding text', () => {
  // Authorization header
  assert.match(scrub('curl -H "Authorization: Bearer sk-abc1234567890XYZ"'), /Bearer \[redacted\]/);
  // sensitive name=value (name + separator kept, value gone)
  assert.equal(scrub('export API_KEY=supersecretvalue'), 'export API_KEY=[redacted]');
  assert.match(scrub('PASSWORD: hunter2hunter2'), /PASSWORD: \[redacted\]/);
  // URL-embedded credentials (user kept, password gone)
  assert.equal(scrub('psql postgres://admin:p4ssw0rd@db.host/app'), 'psql postgres://admin:[redacted]@db.host/app');
  // JWT
  assert.equal(scrub('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.q-aBc_123'), 'jwt [redacted]');
  // vendor key shapes
  assert.equal(scrub('cmdr_ak_deadbeefcafe'), '[redacted]');
  assert.equal(scrub('ghp_0123456789012345678901234567890123'), '[redacted]');
  assert.equal(scrub('AKIAIOSFODNN7EXAMPLE'), '[redacted]');
  // PEM block
  assert.equal(
    scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'),
    '[redacted]',
  );
  // ordinary text is untouched
  assert.equal(scrub('npm run build && git commit -m fix'), 'npm run build && git commit -m fix');
});

test('redactPreview: passthrough when disabled, scrubs when enabled', () => {
  withScrub(false, () => assert.equal(redactPreview('token=abcdef'), 'token=abcdef'));
  withScrub(true, () => assert.equal(redactPreview('token=abcdef'), 'token=[redacted]'));
});

test('toWireStatus: scrubs previews + cwd/title only when opted in', () => {
  const mk = (): AgentStatus => ({
    agentId: 'claude-code:h:s', kind: 'claude-code', host: 'h', sessionId: 's',
    status: 'busy', updatedAt: 1, title: 'fix API_KEY=zzzzsecretzzzz', cwd: '/home/u/proj',
    activeTools: [{ name: 'Bash', inputPreview: 'curl -H "Authorization: Bearer sk-abc1234567890XYZ"' }],
    waiting: { kind: 'approval', text: 'run psql postgres://a:p4ssw0rd@h/db ?', options: ['yes', 'no'] },
    lastReply: 'your key is cmdr_ak_deadbeefcafe ok',
  });

  withScrub(true, () => {
    const w = toWireStatus(mk()) as Record<string, any>;
    assert.match(w.activeTools[0].inputPreview, /Bearer \[redacted\]/);
    assert.match(w.waiting.text, /a:\[redacted\]@/);
    assert.match(w.lastReply, /\[redacted\]/);
    assert.equal(w.lastReply.includes('cmdr_ak_deadbeefcafe'), false);
    assert.equal(w.title, 'fix API_KEY=[redacted]');
  });

  withScrub(false, () => {
    const w = toWireStatus(mk()) as Record<string, any>;
    assert.ok(w.activeTools[0].inputPreview.includes('Bearer sk-abc1234567890XYZ'));
    assert.ok(w.lastReply.includes('cmdr_ak_deadbeefcafe'));
    assert.equal(w.title, 'fix API_KEY=zzzzsecretzzzz');
  });
});
