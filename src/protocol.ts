/**
 * ACAP wire contract — the canonical, agent-agnostic schema (design.html §06).
 * Everything an adapter emits up and accepts down is one of these shapes.
 * Versioned via `v` so adapters and a Commander can evolve independently.
 */

export const ACAP_VERSION = '1.0';
export const SCHEMA_V = 1;

/** Coarse activity state. working = the agent is doing something; waiting = blocked on you. */
export type Status = 'idle' | 'working' | 'waiting' | 'error' | 'ended';

/** ACAP conformance level an adapter implements (design.html §08). */
export type Level = 'L0' | 'L1' | 'L2' | 'L3';

/** Intents a Commander/CLI can push down to an adapter. */
export type Intent = 'prompt' | 'answer' | 'interrupt' | 'mode';
export type Capability = Intent;

/** Canonical, normalized lifecycle events every adapter maps its native events onto. */
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
  ts?: string;                  // hook-side timestamp (advisory; server re-stamps)
  cwd?: string;
  pid?: number;
  tool?: string;                // tool name for Pre/PostToolUse
  toolInput?: unknown;          // slim, capped payload
  title?: string;
  model?: string;
  mode?: string;                // permission mode
  message?: string;             // Notification text
  options?: string[];           // for waiting prompts (e.g. ["yes","no"])
  lastResponse?: string;        // Stop: assistant text preview
  context?: { used: number; limit: number };
  cost?: { usd: number };
  source?: string;              // e.g. "cursor" — used for upgrade-only dedup
  [k: string]: unknown;
}

/** The waiting banner — present only while status === "waiting". */
export interface Waiting {
  kind: 'approval' | 'select' | 'input';
  text: string;
  options: string[];
}

export interface ActiveTool {
  name: string;
  preview?: string;
  startedAt: string;
}

/** A single agent session snapshot — sent up as type:"status". */
export interface AgentStatus {
  v: number;
  agentId: string;              // kind:host:sessionId
  kind: string;
  host: string;
  sessionId: string;
  ts: string;                   // server-stamped
  status: Status;
  title?: string;
  cwd?: string;
  branch?: string;
  model?: string;
  mode?: string;
  activeTool?: ActiveTool;
  context?: { used: number; limit: number };
  cost?: { usd: number };
  waiting?: Waiting;
  lastResponse?: string;
}

/** Pushed down to an adapter (type:"cmd"). */
export interface Command {
  v: number;
  cmdId: string;
  ts: string;
  agentId: string;
  source: string;               // who issued it, e.g. "cli" | "device:beacon-01"
  intent: Intent;
  prompt?: string;              // intent=prompt
  answer?: string;              // intent=answer  (the chosen option / confirm)
  mode?: string;                // intent=mode
}

/** Sent up by the adapter in reply to a Command (type:"ack"). */
export interface Ack {
  v: number;
  cmdId: string;
  status: 'delivered' | 'rejected' | 'nosession';
  detail?: string;
}

/** Adapter → Commander handshake (REST /v1/agents/register, echoed in WS hello). */
export interface Register {
  v: number;
  acap: string;
  kind: string;
  agentId: string;
  level: Level;
  capabilities: Capability[];
  provides: string[];
}

/** Uniform WS envelope (design.html §05). */
export type EnvelopeType =
  | 'hello'
  | 'register'
  | 'status'
  | 'event'
  | 'cmd'
  | 'ack';

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
