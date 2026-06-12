/**
 * ACAP wire contract — the canonical, agent-agnostic schema (docs/spec/ACAP.md §5–10,
 * docs/spec/schemas/*.schema.json are authoritative). Everything an adapter emits up and
 * accepts down is one of these shapes. Versioned via the envelope `v` so an
 * adapter and a Commander evolve independently; new fields are additive/optional.
 */

export const ACAP_VERSION = '1.0';
export const SCHEMA_V = 1;

/** Canonical activity state (status.schema.json). `busy` = doing a turn; `waiting` = blocked on you. */
export type Status = 'idle' | 'busy' | 'waiting' | 'error' | 'ended';

/** ACAP conformance level an adapter implements (spec §11). */
export type Level = 'L0' | 'L1' | 'L2' | 'L3';

/** Intents a Commander can push down to an adapter. */
export type Intent = 'prompt' | 'answer' | 'interrupt' | 'mode';
export type Capability = Intent;

/** Normalized lifecycle events every adapter maps its native events onto. */
export type CanonicalEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PermissionRequest'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd';

/** What an installed hook script sends to the local ingest socket. */
export interface HookEvent {
  v: number;
  kind: string;                 // agent kind, e.g. "claude-code"
  event: CanonicalEvent;        // already normalized by the hook script / adapter
  sessionId: string;
  ts?: string;                  // hook-side timestamp (advisory; hub re-stamps)
  cwd?: string;
  pid?: number;
  tool?: string;                // tool name for Pre/PostToolUse
  toolInput?: unknown;          // slim, capped payload
  title?: string;
  model?: string;
  mode?: string;                // permission mode
  message?: string;             // Notification text
  options?: string[];           // for waiting prompts (e.g. ["yes","no"])
  lastResponse?: string;        // Stop: assistant text preview (→ status.lastReply)
  context?: { used: number; limit: number };
  cost?: { usd: number };
  source?: string;              // e.g. "cursor" — used for upgrade-only dedup
  [k: string]: unknown;
}

/** The waiting banner — present only while status === "waiting" (status.schema.json §8.3). */
export interface Waiting {
  kind: 'approval' | 'input' | 'choice';
  text: string;
  options: string[];
}

/** One running tool (status.schema.json activeTools[]). */
export interface ActiveTool {
  name: string;
  inputPreview?: string;
  startedAt?: number;           // ms epoch
}

/**
 * One agent session snapshot. This IS the ACAP canonical status model (spec §8);
 * `host`/`sessionId` are internal-only keys (binding/roster ergonomics) that the
 * wire serializer strips. Each snapshot is full state — consumers replace, never merge.
 */
export interface AgentStatus {
  agentId: string;              // kind:host:sessionId  (matches the envelope id)
  kind: string;
  host: string;                 // internal-only
  sessionId: string;            // internal-only
  status: Status;
  updatedAt: number;            // ms epoch, when this snapshot was produced
  startedAt?: number;           // ms epoch
  title?: string;
  cwd?: string;
  branch?: string;
  model?: string;
  mode?: string;
  activeTools?: ActiveTool[];
  context?: { used: number; limit: number };
  cost?: { usd: number };
  waiting?: Waiting;
  lastReply?: string;
  lastPrompt?: string;
}

/** Pushed down to an adapter (type:"cmd"; command.schema.json). */
export interface Command {
  cmdId: string;
  intent: Intent;
  agentId: string;              // target session; ON THE WIRE this is the envelope id
  source?: string;              // provenance only, never authz (spec §9.1)
  prompt?: string;              // intent=prompt
  answer?: string | null;       // intent=answer (chosen option / free text)
  mode?: string | null;         // intent=mode
  ts?: string;
  v?: number;
}

/** Sent up by the adapter in reply to a Command (type:"ack"; ack.schema.json). */
export interface Ack {
  cmdId: string;
  status: 'delivered' | 'rejected' | 'nosession' | 'duplicate';
  reason?: string;              // machine-readable, esp. for rejected (spec §9.2)
  detail?: string;              // free-text for logs
  v?: number;
}

/** POST /v1/agents/register body and the `accepted` echo of hello (register.schema.json §7). */
export interface Register {
  v: number;
  acap: string;
  kind: string;
  agentId: string;
  level: Level;
  capabilities: Capability[];
  provides: string[];
  agent?: { displayName?: string; version?: string; icon?: string };
}

/** Success body of POST /v1/agents/register (spec §4.2). */
export interface RegisterResponse {
  v?: number;
  wsToken: string;
  wsUrl: string;
  expiresInSec?: number;        // advisory refresh timer
  heartbeatSec?: number;        // server ping cadence (§6.4)
}

/** First server frame after the WS upgrade (hello.schema.json §6.3). Authoritative `accepted`. */
export interface Hello {
  acap: string;
  sessionId?: string;
  accepted: Register;
  heartbeatSec: number;
  maxEnvelopeBytes?: number;
  minStatusIntervalMs?: number;
}

/** Uniform WS envelope (envelope.schema.json §5). */
export type EnvelopeType =
  | 'hello'
  | 'status'
  | 'event'
  | 'ack'
  | 'cmd'
  | 'ping'
  | 'pong';

export interface Envelope<T = unknown> {
  v: number;
  type: EnvelopeType;
  id?: string;
  ts: string;
  data: T;
}

export function envelope<T>(type: EnvelopeType, data: T, id?: string): Envelope<T> {
  return { v: SCHEMA_V, type, id, ts: new Date().toISOString(), data };
}

/** RECOMMENDED truncation bound for preview strings (spec §8.7.4) so one status stays well under maxEnvelopeBytes. */
export const MAX_PREVIEW_BYTES = 256;

function truncate(s: string): string {
  return s.length > MAX_PREVIEW_BYTES ? s.slice(0, MAX_PREVIEW_BYTES) : s;
}

/**
 * Thin wire serializer: the single source of truth for the `status` payload.
 * Emits exactly the ACAP canonical fields (dropping internal-only host/sessionId),
 * guarantees the four required fields, and truncates preview strings (§8.7.4).
 */
export function toWireStatus(s: AgentStatus): Record<string, unknown> {
  const out: Record<string, unknown> = {
    agentId: s.agentId,
    kind: s.kind,
    status: s.status,
    updatedAt: s.updatedAt,
  };
  if (s.startedAt != null) out.startedAt = s.startedAt;
  if (s.title != null) out.title = s.title;
  if (s.cwd != null) out.cwd = s.cwd;
  if (s.branch != null) out.branch = s.branch;
  if (s.model != null) out.model = s.model;
  if (s.mode != null) out.mode = s.mode;
  if (s.activeTools && s.activeTools.length) {
    out.activeTools = s.activeTools.map((t) => {
      const tool: Record<string, unknown> = { name: t.name };
      if (t.inputPreview != null) tool.inputPreview = truncate(t.inputPreview);
      if (t.startedAt != null) tool.startedAt = t.startedAt;
      return tool;
    });
  }
  if (s.context) out.context = s.context;
  if (s.cost) out.cost = s.cost;
  if (s.waiting) {
    out.waiting = { kind: s.waiting.kind, text: truncate(s.waiting.text), options: s.waiting.options };
  }
  if (s.lastReply != null) out.lastReply = truncate(s.lastReply);
  if (s.lastPrompt != null) out.lastPrompt = truncate(s.lastPrompt);
  return out;
}
