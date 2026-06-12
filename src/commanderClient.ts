/**
 * Commander REST client — the two non-WS ACAP/Commander calls an adapter makes.
 *   • register()  POST /v1/agents/register  (spec §4.2) → wsToken + connection params
 *   • verifyKey() GET  /v1/keys/verify       (login UX; non-normative)
 *
 * Tenant API key (cmdr_ak_…) goes in `Authorization: Bearer`. Uses the global
 * `fetch` (Node ≥ 18/22). Errors carry the HTTP status so the caller can branch
 * (401 → bad key, 409 → acap major mismatch, etc.).
 */
import { Register, RegisterResponse } from './protocol';

/** The live Commander; override with --commander / AGENT_ADAPTER_COMMANDER. */
export const DEFAULT_COMMANDER = 'https://commander-api.autonomous.ai';

export class CommanderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'CommanderError';
  }
}

export interface VerifyKeyResp {
  acap?: string;
  keyName?: string;
  userEmail?: string;
  userName?: string;
  v?: number;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

/** POST /v1/agents/register. Returns the raw ACAP register response (not enveloped). */
export async function register(
  commanderUrl: string,
  tenantKey: string,
  body: Register,
): Promise<RegisterResponse> {
  const res = await fetch(`${base(commanderUrl)}/v1/agents/register`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tenantKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new CommanderError(res.status, `register failed: ${res.status} ${await safeText(res)}`);
  }
  const json = (await res.json()) as RegisterResponse;
  if (!json || !json.wsToken || !json.wsUrl) {
    throw new CommanderError(res.status, 'register response missing wsToken/wsUrl');
  }
  return json;
}

/** GET /v1/keys/verify. Fail-fast login UX: confirm the key and identify the account. */
export async function verifyKey(commanderUrl: string, tenantKey: string): Promise<VerifyKeyResp> {
  const res = await fetch(`${base(commanderUrl)}/v1/keys/verify`, {
    headers: { authorization: `Bearer ${tenantKey}` },
  });
  if (!res.ok) {
    throw new CommanderError(res.status, `key verify failed: ${res.status} ${await safeText(res)}`);
  }
  return (await res.json()) as VerifyKeyResp;
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}
