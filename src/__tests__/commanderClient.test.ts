import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, verifyKey, CommanderError, DEFAULT_COMMANDER } from '../commanderClient';
import { Register, SCHEMA_V, ACAP_VERSION } from '../protocol';

const REG: Register = {
  v: SCHEMA_V, acap: ACAP_VERSION, kind: 'claude-code', agentId: 'claude-code:h:adapter',
  level: 'L3', capabilities: ['prompt'], provides: ['status'],
};

type FetchArgs = { url: string; init: any };
function withFetch<T>(impl: (args: FetchArgs) => any, body: () => Promise<T>): Promise<T> {
  const orig = (globalThis as any).fetch;
  const calls: FetchArgs[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => { calls.push({ url, init }); return impl({ url, init }); };
  return body().finally(() => { (globalThis as any).fetch = orig; (body as any).calls = calls; });
}

test('register: posts Bearer-authed body and returns wsToken/wsUrl', async () => {
  let seen: FetchArgs | null = null;
  await withFetch((a) => { seen = a; return {
    ok: true,
    json: async () => ({ v: 1, wsToken: 'tok', wsUrl: 'wss://cmd/v1/agent', expiresInSec: 900, heartbeatSec: 30 }),
  }; }, async () => {
    const res = await register('https://commander-api.autonomous.ai/', 'cmdr_ak_x', REG);
    assert.equal(res.wsToken, 'tok');
    assert.equal(res.wsUrl, 'wss://cmd/v1/agent');
  });
  assert.ok(seen);
  assert.equal((seen as any).url, 'https://commander-api.autonomous.ai/v1/agents/register'); // trailing slash stripped
  assert.equal((seen as any).init.method, 'POST');
  assert.equal((seen as any).init.headers.authorization, 'Bearer cmdr_ak_x');
});

test('register: non-2xx throws CommanderError with status', async () => {
  await withFetch(() => ({ ok: false, status: 401, text: async () => 'unauthorized' }), async () => {
    await assert.rejects(
      () => register(DEFAULT_COMMANDER, 'bad', REG),
      (e: unknown) => e instanceof CommanderError && (e as CommanderError).status === 401,
    );
  });
});

test('register: missing wsToken in body throws', async () => {
  await withFetch(() => ({ ok: true, json: async () => ({ v: 1 }) }), async () => {
    await assert.rejects(() => register(DEFAULT_COMMANDER, 'k', REG), /missing wsToken/);
  });
});

test('verifyKey: returns account info on success', async () => {
  let seen: FetchArgs | null = null;
  await withFetch((a) => { seen = a; return {
    ok: true, json: async () => ({ acap: '1.0', userEmail: 'me@x.io', keyName: 'laptop', v: 1 }),
  }; }, async () => {
    const who = await verifyKey('https://commander-api.autonomous.ai', 'cmdr_ak_x');
    assert.equal(who.userEmail, 'me@x.io');
  });
  assert.equal((seen as any).url, 'https://commander-api.autonomous.ai/v1/keys/verify');
  assert.equal((seen as any).init.headers.authorization, 'Bearer cmdr_ak_x');
});

test('verifyKey: non-2xx throws, and safeText tolerates a throwing body', async () => {
  await withFetch(() => ({ ok: false, status: 403, text: async () => { throw new Error('no body'); } }), async () => {
    await assert.rejects(
      () => verifyKey(DEFAULT_COMMANDER, 'k'),
      (e: unknown) => e instanceof CommanderError && (e as CommanderError).status === 403,
    );
  });
});
