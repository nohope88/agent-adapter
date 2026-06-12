# ACAP — Agent Commander Adapter Protocol

**Version:** 1.0 · **Status:** Draft · **Date:** 2026-06-11

ACAP is the open, versioned contract between an **Agent Commander** backend and the
**adapters** that report agent status to it and deliver commands back. It fixes the
wire shape, the connection lifecycle, and the capability handshake — and nothing else.
*How* an adapter reads an agent's status or injects a prompt is deliberately out of
scope: file tail, log scrape, hook/plugin, native API, or SDK are all conformant as
long as what crosses the wire matches this document.

> One sentence: **an adapter normalizes one agent into the canonical status model and
> accepts canonical commands.** Everything below is the precise definition of "canonical."

This is the contract a community developer implements to make a new agent show up on a
Commander and become voice-/command-controllable, without writing a line of
backend-specific code and without the backend learning anything agent-specific.

---

## 0. Conformance language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

A conformant **adapter** is one that passes `acap-verify` at a declared level
(see [conformance.md](./conformance.md)). A conformant **Commander** is one that accepts
any conformant adapter at any level without agent-specific code.

Every normative wire shape in this document has a machine-checkable counterpart under
[`schemas/`](./schemas/). Where prose and schema disagree, **the schema is authoritative**.

---

## 1. Scope and goals

### 1.1 Goals

1. **Anyone can add an agent.** A read-only ("Observer") adapter is an afternoon of work:
   emit the canonical status model from whatever the agent already writes.
2. **Capabilities are declared, never assumed.** An adapter advertises exactly what it can
   do; the Commander tailors routing and device UI to that and degrades gracefully.
3. **The backend stays agent-agnostic.** No `if kind == "codex"` anywhere in the Commander.
   All agent-specific knowledge lives in the adapter.
4. **Forward- and backward-compatible.** New fields are additive and optional; old adapters
   and old backends keep working across minor versions.
5. **Secure by construction.** The transport authenticates the adapter and binds it to one
   tenant and one agent identity before any message is trusted.

### 1.2 Non-goals

- ACAP does **not** define how the Commander renders devices, runs speech-to-text, or pairs
  hardware. Those are Commander-internal. ACAP stops at the adapter boundary.
- ACAP does **not** define how an adapter discovers, reads, or controls its agent. That is
  the adapter's private business.
- ACAP is **not** a transport for bulk binary (audio, file contents). It carries small,
  structured JSON. (Audio in Agent Commander uses a separate device-side channel.)

---

## 2. Roles and terminology

| Term | Definition |
|------|------------|
| **Agent** | A running AI coding agent instance (a Claude Code session, a Codex run, an openclaw process…). |
| **Adapter** | A process implementing ACAP for one *kind* of agent. It MAY represent many agent instances over one connection (a session map). |
| **Commander** | The backend. Multi-tenant, stateful, the only party that authorizes commands and fans status out. |
| **Tenant** | The isolation boundary. Every adapter, agent, command, and status row belongs to exactly one tenant. |
| **Principal** | The authenticated identity behind a connection. For ACAP it is always an adapter, resolved to `{tenant, agentId, capabilities}`. |
| **Capability / intent** | A command class an adapter accepts: `prompt`, `answer`, `interrupt`, `mode`. |
| **Provides** | The set of canonical status fields an adapter populates. |
| **Level** | A coarse conformance tier L0–L3 (see §11). |

A single adapter process MAY multiplex multiple agent instances of the same `kind`. Each
instance has a distinct `agentId`; every `status`/`event`/`ack` names the `agentId` it
concerns. The connection is authenticated once; per-agent identity rides in the payload.

---

## 3. Where the adapter sits

```
   agent process(es)          adapter (ACAP client)          Commander (ACAP server)
  ┌──────────────┐   private  ┌────────────────────┐  WSS   ┌─────────────────────┐
  │ Claude Code  │◄──hook────►│ normalize → status │═══════►│ ingest · differ     │
  │  (or Codex,  │   tail     │ AdapterRuntime:    │  REST  │ snapshot · fan-out  │
  │  openclaw…)  │   pty/API  │  auth·reconnect·   │◄══════ │ router · authz      │
  └──────────────┘            │  throttle·dedup    │  cmd   └─────────────────────┘
                              │ send() ◄ cmd       │
                              └────────────────────┘
```

The left edge (agent ↔ adapter) is **out of scope**. The right edge (adapter ↔ Commander)
is **the entirety of ACAP**.

---

## 4. Transport binding

### 4.1 Connections

ACAP defines exactly two interactions:

| # | Channel | Endpoint | Method/Upgrade | Purpose |
|---|---------|----------|----------------|---------|
| 1 | Registration | `POST /v1/agents/register` | HTTPS | Exchange a tenant API key for a short-lived WS token; declare capabilities. |
| 2 | Control | `wss://…/v1/agent` | WebSocket over TLS | Persistent bidirectional stream of typed messages. |

- All transport **MUST** be TLS 1.3 (or later). Plaintext `ws://`/`http://` is permitted
  **only** against `localhost` loopback during development and **MUST NOT** be used otherwise.
- The Commander's certificate **MUST** be verified by the adapter. Adapters **SHOULD** allow
  a configured CA bundle for self-hosted Commanders; they **MUST NOT** disable verification
  by default.

### 4.2 Registration (REST)

`POST /v1/agents/register` with the tenant API key in `Authorization: Bearer <key>` and a
[register](./schemas/register.schema.json) body (§7). On success the Commander returns:

```json
{
  "v": 1,
  "wsToken": "eyJ…",          // short-lived, scoped to {tenant, agentId, capabilities}
  "wsUrl": "wss://api.example.com/v1/agent",
  "expiresInSec": 900,
  "heartbeatSec": 30          // server's expected ping cadence (§6.4)
}
```

- The `wsToken` is **short-lived** (the Commander chooses; `expiresInSec` is advisory for
  the adapter's refresh timer). The adapter **MUST** re-register to obtain a fresh token
  before expiry or after a `4401` close (§14).
- The token, not the payload, fixes the tenant. The Commander **MUST** ignore any tenant
  identifier an adapter puts in a message body and derive tenant solely from the
  authenticated principal.

### 4.3 Control connection (WebSocket)

- The adapter opens the WS to `wsUrl`, presenting the token. ACAP defines two token
  presentations; a Commander **MUST** accept at least (a):
  - **(a)** `Authorization: Bearer <wsToken>` on the upgrade request, **or**
  - **(b)** subprotocol `acap.v1.bearer.<wsToken>` for clients that cannot set headers.
- Messages are WebSocket **text** frames, each carrying exactly one JSON
  [envelope](#5-message-envelope) (§5). Binary frames are reserved and **MUST** be ignored
  by both parties in ACAP 1.0.
- A single logical message **MUST** fit in a single WebSocket message (no application-level
  fragmentation). Commanders **MUST** accept envelopes up to **64 KiB**; adapters **SHOULD**
  keep individual messages well under that (truncate `inputPreview`, `lastReply`, etc.).

### 4.4 Why WebSocket and not a broker

The Commander transforms every status message into a render/route decision and authorizes
every command — it is not a relay. A pub/sub broker would add a hop without removing the app
server, and would split authorization across broker ACLs. One authenticated socket per
adapter keeps authz in exactly one place: the app layer that already routes. This is a fixed
decision of ACAP 1.0, not a deployment option.

---

## 5. Message envelope

Every WS message — in both directions — is a single JSON object with this envelope:

```json
{
  "v": 1,
  "type": "status",
  "id": "claude-code:mbp.local:8123",
  "ts": "2026-06-11T22:14:07.182Z",
  "data": { /* type-specific payload */ }
}
```

| Field | Type | Rule |
|-------|------|------|
| `v` | integer | Envelope/schema major version. **MUST** be `1` for ACAP 1.0. Unknown `v` → receiver **MUST** ignore the message (and **SHOULD** log). |
| `type` | string | One of the message types in §5.1. Unknown `type` → receiver **MUST** ignore the message, **MUST NOT** close the connection. |
| `id` | string | The `agentId` (adapter→server) or target `agentId` (server→adapter) the message concerns. Echoed for logging/correlation even though the connection is authenticated. |
| `ts` | string | RFC 3339 / ISO 8601 UTC timestamp with millisecond precision, e.g. `2026-06-11T22:14:07.182Z`. |
| `data` | object | The type-specific payload. **MUST** be present (may be `{}`). |

Forward-compatibility rule (applies everywhere): **receivers MUST ignore unknown object keys**
and **MUST NOT** reject a message solely because it contains keys they don't recognize. This
is what makes additive evolution safe.

### 5.1 Message types

| `type` | Direction | Payload schema | Meaning |
|--------|-----------|----------------|---------|
| `hello` | server → adapter | [hello](./schemas/hello.schema.json) | First server message after upgrade; echoes negotiated capabilities, heartbeat, limits. |
| `status` | adapter → server | [status](./schemas/status.schema.json) | Full current snapshot for one agent instance. |
| `event` | adapter → server | [event](./schemas/event.schema.json) | A discrete, optional notification (e.g. `compacted`, `subagentSpawned`). Never required. |
| `ack` | adapter → server | [ack](./schemas/ack.schema.json) | Result of a `cmd` the adapter received. |
| `cmd` | server → adapter | [command](./schemas/command.schema.json) | A command to deliver into a specific agent. |
| `ping` / `pong` | both | `{}` | Application heartbeat (§6.4). |

There is no adapter-side `register` *message*; registration is the REST call in §4.2,
re-stated in the WS `hello` for the record.

---

## 6. Connection lifecycle

```
  register (REST)            upgrade (WSS)          hello             steady state
  ──────────────►  wsToken  ──────────────►  ◄── hello ───  ┌──► status / event / ack ──►
                                                            │◄── cmd ──
                                                            │◄── ping ── / ── pong ──►
                                                            └ reconnect on drop (§6.5)
```

### 6.1 Register

The adapter calls `POST /v1/agents/register` (§4.2) and receives `wsToken` + connection
params. It **MUST NOT** attempt the WS upgrade without a valid token.

### 6.2 Upgrade

The adapter opens the WS with the token (§4.3). On a `401`/`4401` it **MUST** re-register
(token expired/revoked) rather than retry the same token.

### 6.3 Hello

Immediately after a successful upgrade, the Commander **MUST** send exactly one `hello`:

```json
{ "v": 1, "type": "hello", "id": "codex:ci-box:4471", "ts": "…",
  "data": {
    "acap": "1.0",
    "sessionId": "conn-7f3a…",          // this connection's id, for logs
    "accepted": {                        // capabilities the Commander will route to this adapter
      "level": "L1",
      "capabilities": ["prompt"],
      "provides": ["status","activeTool","model","tokens"]
    },
    "heartbeatSec": 30,
    "maxEnvelopeBytes": 65536,
    "minStatusIntervalMs": 250           // floor between status messages per agent (§8.6)
  } }
```

- The adapter **MUST NOT** send `status`/`event`/`ack` before receiving `hello`. (It MAY
  reply to `ping`.)
- `accepted` MAY narrow what the adapter requested at registration (e.g. the Commander
  refuses an intent the tenant policy disallows). The adapter **MUST** treat `accepted` as
  authoritative and not send commands it implies are unsupported.

### 6.4 Heartbeat

- Heartbeat is **server-initiated**. The Commander sends `ping` roughly every `heartbeatSec`;
  the adapter **MUST** reply `pong` promptly (within `heartbeatSec`).
- An adapter that receives no `ping` for `2 × heartbeatSec` **SHOULD** treat the connection
  as dead and reconnect.
- The Commander marks an agent **offline** when it misses heartbeats; this replaces any
  "last will." Adapters **MAY** also send an unsolicited `ping` if they need to probe
  liveness; the Commander **MUST** answer with `pong`.

### 6.5 Reconnect and resynchronization

- On any disconnect the adapter **MUST** reconnect with exponential backoff (base ≤ 1 s,
  cap ≥ 30 s, full jitter) and **MUST NOT** hot-loop.
- After reconnect the adapter **MUST** send a fresh `status` for **every** agent instance it
  currently represents — ACAP carries **no retained state across connections**. The Commander
  treats the post-reconnect statuses as the new ground truth and reconciles (an agent absent
  from the resync is *not* implicitly ended; see §8.5 for ending semantics).
- The Commander **MUST** tolerate duplicate `status` for an unchanged agent after reconnect
  (idempotent by construction — see the differ in §8.6).

### 6.6 Graceful close

To shut down cleanly an adapter **SHOULD** send a terminal `status` with
`status:"ended"` for each agent it owns, then close the WS with code `1000`. A Commander
**MUST NOT** require this — a dropped socket plus heartbeat timeout is an equally valid end.

---

## 7. Registration & capability model

The single most important idea in ACAP: **the adapter declares, the Commander adapts.**

The register body (REST) and the `accepted` block of `hello` share this shape:

```json
{
  "v": 1,
  "acap": "1.0",
  "kind": "codex",
  "agentId": "codex:ci-box:4471",
  "level": "L1",
  "capabilities": ["prompt"],
  "provides": ["status","activeTool","model","tokens"],
  "agent": {                       // OPTIONAL descriptive metadata, for the dashboard
    "displayName": "Codex",
    "version": "codex-cli/0.21.0",
    "icon": "https://…/codex.svg"
  }
}
```

| Field | Type | Rule |
|-------|------|------|
| `acap` | string | ACAP version the adapter implements, `"1.0"`. Major-version mismatch → Commander **MUST** reject registration with `409`. |
| `kind` | string | Stable agent-type slug, lowercase kebab: `claude-code`, `codex`, `openclaw`, `hermes`. Registry-governed (§ [registry.md](./registry.md)). |
| `agentId` | string | Globally-unique-within-tenant id for this instance. RECOMMENDED form `kind:host:disc` where `disc` is a PID or port. Opaque to the Commander otherwise. |
| `level` | string | Declared conformance level `L0`–`L3` (§11). **MUST** be consistent with `capabilities`/`provides`. |
| `capabilities` | string[] | Subset of `["prompt","answer","interrupt","mode"]`. The intents this adapter will accept as `cmd`. L0 → `[]`. |
| `provides` | string[] | Canonical status fields this adapter will populate (the field keys of §8). The Commander uses this to drive UI: fields not listed are treated as "unknown," not "empty." |

If an adapter manages many instances, it registers/declares **per `agentId`** (one register
call per instance) but **MAY** share one WS connection for all of them. The `hello` is per
connection; the adapter then streams `status` for each `agentId`.

### 7.1 `provides` vs. presence

`provides` is a *promise about which fields are meaningful*, not a guarantee a field is
non-empty at every instant. The Commander uses `provides` to decide whether to show a UI
affordance at all (e.g. hide the cost readout for an adapter that doesn't list `cost`),
while per-message presence reflects the live value. An adapter **MUST NOT** list a field in
`provides` that it never populates.

---

## 8. Canonical status model

This is the heart of the contract — the normalized shape every agent is mapped into. It is
the networked, versioned heir of agent-status's `SessionSnapshot`/`EnrichedSession` and is
field-compatible with the reference Commander's `model.Session` (see §15 for the exact
mapping). Authoritative schema: [`schemas/status.schema.json`](./schemas/status.schema.json).

```json
{
  "v": 1,
  "agentId": "claude-code:mbp.local:8123",
  "kind": "claude-code",
  "status": "waiting",
  "attention": "needsYou",
  "title": "Refactor auth module",
  "cwd": "~/repos/api",
  "branch": "feat/auth",
  "model": "claude-opus-4-8",
  "mode": "default",
  "classification": "plain",
  "activeTools": [
    { "name": "Bash", "inputPreview": "xcodebuild test", "startedAt": 1749161647000 }
  ],
  "tokens": { "input": 142000, "output": 8300, "cacheRead": 51000, "cacheWrite": 1200 },
  "context": { "used": 142000, "limit": 200000 },
  "cost": { "usd": 1.23 },
  "waiting": {
    "kind": "approval",
    "text": "Run Bash xcodebuild?",
    "options": ["yes", "no"]
  },
  "todos": [ { "title": "wire STT", "status": "in_progress" } ],
  "workflow": null,
  "lastPrompt": "refactor the auth module",
  "lastReply": "I'll start by reading auth.ts…",
  "errorCount": 0,
  "lastStopReason": "",
  "startedAt": 1749161600000,
  "updatedAt": 1749161647182
}
```

### 8.1 Required core fields (every level, including L0)

| Field | Type | Notes |
|-------|------|-------|
| `agentId` | string | Matches the envelope `id`. |
| `kind` | string | Same slug as registration. |
| `status` | enum | `idle` \| `busy` \| `waiting` \| `error` \| `ended`. See §8.4. |
| `updatedAt` | int64 | Milliseconds since Unix epoch; when this snapshot was produced. |

Everything else is **optional** and gated by `provides`. An L0 adapter MAY send only the
four required fields plus whatever it can cheaply derive.

### 8.2 Field reference

| Field | Type | `provides` key | Meaning |
|-------|------|----------------|---------|
| `attention` | enum `needsYou`\|`running`\|`idle` | derived | Coarse "do I need a human" signal. If omitted, the Commander derives it from `status` (`waiting`/`error`→`needsYou`, `busy`→`running`, else `idle`). |
| `title` | string | `title` | Human-readable session title (Claude Code's `aiTitle`). |
| `cwd` | string | `cwd` | Working directory; may be `~`-abbreviated. |
| `branch` | string | `branch` | Git branch, if any. |
| `model` | string | `model` | Model id, e.g. `claude-opus-4-8`. |
| `mode` | string | `mode` | Permission mode, e.g. `default`, `plan`, `bypassPermissions`. |
| `classification` | enum `plain`\|`loop`\|`workflow` | `classification` | Shape of the session; drives `workflow`. |
| `activeTools` | ToolActivity[] | `activeTool` | Tools currently running (§8.3). Empty when none. |
| `tokens` | Tokens | `tokens` | `{input,output,cacheRead,cacheWrite}`, all integers. **Per-session cumulative**, already de-cumulated where the source reports running totals (§8.7). |
| `context` | `{used:int, limit:int}` | `context` | Context-window occupancy. `limit` reflects the active window (e.g. 1 000 000 for `[1m]`). |
| `cost` | `{usd:number}` | `cost` | Cumulative USD for the session. |
| `waiting` | Waiting | `waiting` | Present only when `status:"waiting"` (§8.3). |
| `todos` | Todo[] | `todos` | Ordered task list; each `{title, status}` where status ∈ `pending`\|`in_progress`\|`completed`. |
| `workflow` | Workflow \| null | `workflow` | Structured multi-agent/loop detail (§8.3); null/omitted for `plain`. |
| `lastPrompt` | string | `lastPrompt` | Most recent user/inbound prompt (truncated). |
| `lastReply` | string | `lastReply` | Most recent agent reply preview (truncated). |
| `errorCount` | int | `errorCount` | Errors observed this session. |
| `lastStopReason` | string | — | Why the agent last stopped, if known. |
| `startedAt` | int64 | — | Session start, ms epoch. |
| `pid` | int | — | OS PID, if local; enables liveness (§8.5). |

### 8.3 Nested object shapes

```jsonc
// ToolActivity
{ "name": "Bash", "inputPreview": "xcodebuild test", "startedAt": 1749161647000 }

// Tokens (all integers, cumulative for the session)
{ "input": 142000, "output": 8300, "cacheRead": 51000, "cacheWrite": 1200 }

// Waiting (present iff status == "waiting")
{ "kind": "approval",          // approval | input | choice
  "text": "Run Bash xcodebuild?",
  "options": ["yes", "no"] }   // omitted/empty for free-text input

// Todo
{ "title": "wire STT", "status": "in_progress" }   // pending | in_progress | completed

// Workflow (present iff classification != "plain")
{ "label": "review-changes",
  "iteration": 3, "phaseCurrent": 2, "phaseTotal": 4,
  "subagents": [ { "type": "reviewer", "desc": "audit auth", "state": "running", "currentTool": "Read" } ],
  "tasks":     [ { "subject": "verify finding #2", "status": "in_progress", "blockedBy": [] } ] }
```

### 8.4 Status semantics (state machine)

| `status` | Meaning | Typical trigger |
|----------|---------|-----------------|
| `idle` | Alive, no active turn, awaiting a human prompt. | Stop/SubagentStop with nothing pending. |
| `busy` | Actively working a turn (model thinking or tool running). | UserPromptSubmit / PreToolUse. |
| `waiting` | Blocked on a human decision; `waiting` object **MUST** be present. | Permission/approval request. |
| `error` | Last turn failed; `errorCount` SHOULD reflect it. | Tool/agent error. |
| `ended` | Session is over; the `agentId` will not produce more statuses. | Process exit / explicit stop. |

The Commander treats `ended` as terminal for that `agentId`. An adapter **MUST NOT** keep
re-sending status for an `ended` agent (beyond the single terminal message). A *new* run on
the same machine **MUST** use a new `agentId`.

### 8.5 Liveness — never get stuck "busy"

A core lesson from the reference implementations: **an agent hard-killed mid-turn fires no
stop signal**, so naive status sticks at `busy` forever. Therefore:

- An adapter representing a local process **SHOULD** populate `pid` and run a liveness check
  (PID existence, or a per-agent timeout). When liveness fails while `status` is non-terminal,
  the adapter **MUST** emit `status:"ended"` (with `lastStopReason:"liveness"`).
- An adapter that cannot determine liveness **MUST** apply a staleness timeout: if no fresh
  observation arrives within an adapter-chosen bound, downgrade `busy`→`idle` or emit `ended`,
  rather than reporting stale `busy` indefinitely.

### 8.6 Send-on-change (the `coreEqual` gate)

The Commander de-dupes, but adapters **MUST** throttle to keep the wire (and a tiny device)
quiet:

- An adapter **MUST NOT** send a new `status` for an agent unless a **meaningful** field
  changed since its last send for that agent. `updatedAt` changing alone is **not** meaningful
  — it **MUST** be excluded from the comparison. (This mirrors the reference differ, which
  zeroes `updatedAt` before comparing.)
- An adapter **MUST NOT** exceed one `status` per agent per `minStatusIntervalMs` (from
  `hello`; default 250 ms). Coalesce rapid changes into the latest snapshot.
- Each `status` is a **full snapshot**, not a delta. Consumers replace, never merge. (This is
  the same "emit full state, `bufferingNewest(1)`" discipline as the lineage `SessionProvider`.)

### 8.7 Normalization rules an adapter MUST apply

These are the cross-agent traps that, unhandled, corrupt the canonical model:

1. **Cumulative-token sources.** Some agents (e.g. Codex) report *cumulative* token totals on
   every event. The adapter **MUST** convert to the canonical per-session cumulative
   convention without double-counting — if the source resets or restarts mid-session, the
   adapter is responsible for a monotonic, non-double-counted total.
2. **Sidechain / subagent accounting.** Messages billed but excluded from the main turn (Claude
   Code "sidechain") **MUST** be included in `cost`/`tokens` but **MUST NOT** inflate
   `context.used` for the parent turn.
3. **List-replace vs. incremental todos.** Some agents replace the whole todo list each update
   (`TodoWrite`), others mutate incrementally (`TaskCreate`/`TaskUpdate`). The adapter
   normalizes both into the current full `todos` array.
4. **Truncation.** `inputPreview`, `lastPrompt`, `lastReply` **MUST** be truncated by the
   adapter (RECOMMENDED ≤ 256 bytes) so a single status never approaches `maxEnvelopeBytes`.

---

## 9. Commands and acknowledgements

### 9.1 `cmd` (server → adapter)

```json
{ "v": 1, "type": "cmd", "id": "claude-code:mbp.local:8123", "ts": "…",
  "data": {
    "cmdId": "3f9c8e21-…",         // unique; the dedup + ack key
    "intent": "prompt",            // prompt | answer | interrupt | mode
    "source": "device:beacon-01",  // provenance, for audit/logs
    "prompt": "run the tests again",
    "answer": null,                // set when intent == "answer"
    "mode": null                   // set when intent == "mode"
  } }
```

| Field | Required when | Notes |
|-------|---------------|-------|
| `cmdId` | always | UUID/opaque. The unit of idempotency and ack correlation. |
| `intent` | always | One of the four intents; **MUST** be in the adapter's `accepted.capabilities`. |
| `prompt` | `intent=="prompt"` | The text to inject as a fresh turn. |
| `answer` | `intent=="answer"` | The chosen option (matching a `waiting.options` value) or free text for `waiting.kind=="input"`. |
| `mode` | `intent=="mode"` | Target permission mode string. |
| `source` | optional | Human-readable origin; the adapter MAY log but **MUST NOT** make authz decisions on it (the Commander already authorized). |

The Commander **MUST NOT** send an `intent` the adapter did not declare. If it does anyway,
the adapter **MUST** reply `ack` with `status:"rejected"`, `reason:"unsupported-intent"`.

### 9.2 `ack` (adapter → server)

Every `cmd` **MUST** produce exactly one `ack`, correlated by `cmdId`:

```json
{ "v": 1, "type": "ack", "id": "claude-code:mbp.local:8123", "ts": "…",
  "data": {
    "cmdId": "3f9c8e21-…",
    "status": "delivered",        // delivered | rejected | nosession | duplicate
    "detail": "injected into pty"
  } }
```

| `ack.status` | Meaning |
|--------------|---------|
| `delivered` | The command was injected/applied into the agent. |
| `rejected` | The adapter refused it (`reason` SHOULD say why: `unsupported-intent`, `bad-answer`, `agent-error`). |
| `nosession` | No live agent with that `agentId` right now. |
| `duplicate` | This `cmdId` was already processed; no second injection happened (§9.3). |

### 9.3 Delivery semantics — at-least-once + idempotency

- Command fan-out is **at-least-once**: after a reconnect or retry the Commander MAY redeliver
  a `cmd`. Therefore the adapter **MUST** dedupe on `cmdId` and **MUST NOT** inject the same
  `cmdId` twice. A redelivered `cmdId` already applied → reply `ack:"duplicate"`.
- The adapter **SHOULD** retain recent `cmdId`s for at least the reconnect window (RECOMMENDED
  ≥ 5 min or 1 000 ids, whichever first).
- The Commander correlates by `cmdId`; if no `ack` arrives within its timeout it MAY redeliver
  (hence the dedup requirement above).

### 9.4 Intent → mechanism is the adapter's business

How an intent is realized is entirely the adapter's choice and never crosses the wire:

| intent | example realizations (non-normative) |
|--------|--------------------------------------|
| `prompt` | pty/tmux send-keys · native input API · SDK headless re-drive |
| `answer` | return the decision from a *blocking* permission hook · native approval API |
| `interrupt` | `SIGINT` to the agent PID · native cancel RPC (never a faked `ESC` keystroke if a clean path exists) |
| `mode` | native mode switch · config reload |

The Commander only ever routes intents an adapter advertised; it has no knowledge of the
mechanism.

---

## 10. Events

`event` is an **optional, never-required** discrete notification for things that aren't a
status field but are worth surfacing (UI flourish, audit, analytics). Examples:
`{ "name": "compacted" }`, `{ "name": "subagentSpawned", "subagentType": "reviewer" }`,
`{ "name": "interrupted", "by": "user" }`. The Commander **MUST** function fully with an
adapter that never sends events. An adapter **MUST NOT** encode required state in an event
that isn't also reflected in `status`.

---

## 11. Conformance levels

Full requirements and the verifier contract are in [conformance.md](./conformance.md); the
summary:

| Level | Name | Adds | `capabilities` |
|-------|------|------|----------------|
| **L0** | Observer | Canonical `status` up, read-only. | `[]` |
| **L1** | Promptable | Accept `prompt`. | `["prompt"]` |
| **L2** | Interactive | Accept `answer`, `interrupt`, `mode`. | `["prompt","answer","interrupt","mode"]` (subset allowed) |
| **L3** | Rich | Full-fidelity status: structured tool events, `todos`, per-message `cost`, `workflow`. | as L2 |

The Commander **MUST** degrade gracefully: an L0 agent appears with voice-prompt disabled; a
device hides `cost`/`todos` an adapter doesn't `provide`. **No capability is ever assumed.**

---

## 12. Versioning and extensibility

- **Envelope `v`** is the wire major version (`1`). A receiver **MUST** ignore an envelope
  whose `v` it doesn't implement.
- **`acap`** (the semver string in registration/hello) tracks the protocol revision. Minor
  bumps (`1.0`→`1.1`) are **additive only**: new optional fields, new enum members marked
  non-breaking, new optional message types. A receiver **MUST** ignore unknown fields, unknown
  `type`s, and unknown enum members (treating an unknown enum value as "absent/unknown," never
  as an error).
- **Breaking changes** require a major bump (`2.0`) and a new envelope `v`. A Commander MAY
  support multiple major versions concurrently on distinct endpoints (`/v1/agent`,
  `/v2/agent`).
- Adding a new **capability** or **status field** is a minor change: old adapters simply don't
  declare/populate it; old Commanders ignore it.

This is the property that lets "the community freely build adapters": an adapter written
against 1.0 keeps working against a 1.x Commander forever, and vice-versa.

---

## 13. Security requirements (adapter obligations)

The Commander owns tenant isolation and command authorization. The adapter's obligations:

1. **Verify TLS.** Never disable certificate verification by default (§4.1).
2. **Protect the API key.** The tenant API key grants registration for the tenant; store it
   only in OS-appropriate secret storage / env, never in the status payload or logs.
3. **Treat the `wsToken` as a bearer secret.** Short-lived; refresh on expiry; never log it.
4. **Dedupe commands (§9.3).** At-least-once delivery + a Bash-capable agent means a
   double-injected prompt is a real-world hazard. `cmdId` dedup is **MUST**, not SHOULD.
5. **Don't infer destructive intent.** The adapter applies the intent it's given; it does not
   synthesize `interrupt`/`answer` from anything ambiguous. (The Commander likewise only
   derives `prompt` from voice; `answer`/`interrupt` require an explicit device affordance.)
6. **Least privilege at the edge.** The adapter SHOULD run with no more OS privilege than its
   injection mechanism requires.

A cross-tenant leak or an unauthenticated command path is the highest-severity class of bug in
the system; ACAP is designed so the adapter can do nothing across tenants because its
credential fixes one tenant before any message is read.

---

## 14. Errors and close codes

ACAP uses WebSocket close codes plus an optional final error frame.

| Code | Name | When |
|------|------|------|
| `1000` | Normal | Graceful close (§6.6). |
| `1011` | Internal error | Commander-side fault; adapter reconnects with backoff. |
| `4400` | Bad message | A malformed envelope that can't be ignored at the frame level. The offending party SHOULD have ignored, not closed, for *unknown* types/fields — `4400` is for truly unparseable frames. |
| `4401` | Unauthorized | Token expired/revoked/invalid. Adapter **MUST** re-register (§6.2) before reconnecting. |
| `4403` | Forbidden | Principal valid but not allowed (e.g. tenant quota exceeded). Adapter backs off; SHOULD surface to operator. |
| `4408` | Heartbeat timeout | Commander closed a silent socket. Adapter reconnects. |
| `4429` | Rate limited | Adapter exceeded `minStatusIntervalMs` or per-tenant quota. Adapter MUST slow down. |

A party MAY precede a close with one `event`-shaped error frame:
`{ "v":1, "type":"event", "data": { "name":"error", "code":4429, "message":"slow down" } }`.
Recipients **MUST NOT** depend on receiving it.

---

## 15. Relationship to the reference implementation

ACAP's canonical status model is field-compatible with the reference Commander's Go
`model.Session` (`commander/internal/model/model.go`). The mapping is 1:1 except where ACAP
adds networked/device fields the local model didn't need yet. Adapters that emit ACAP feed the
reference Commander directly.

| ACAP `status` field | `model.Session` field | Note |
|---------------------|-----------------------|------|
| `agentId` | `ID` | identity |
| `kind` | `Kind` | — |
| `status` | `Status` | reference uses `stopped`; ACAP standardizes the terminal value as **`ended`** (the Commander maps the alias). |
| `attention` | `Attention` | `needsYou`/`running`/`idle` |
| `title` | `AITitle` | renamed for protocol clarity |
| `cwd` | `Cwd` | — |
| `branch` | *(added)* | from per-record git branch |
| `model` | `Model` | — |
| `mode` | `PermissionMode` | — |
| `classification` | `Classification` | `plain`/`loop`/`workflow` |
| `activeTools[]` | `CurrentTools[]` | `{name,inputPreview,startedAt}` identical |
| `tokens` | `Tokens` | `{input,output,cacheRead,cacheWrite}` identical |
| `context` | *(added)* | `{used,limit}`; `[1m]` → limit 1 000 000 |
| `cost.usd` | `CostUSD` | object-wrapped on the wire |
| `waiting` | `WaitingFor` (+structure) | ACAP structures it as `{kind,text,options}` |
| `todos[]` | `Workflow.Tasks` / TodoWrite | normalized to `{title,status}` |
| `workflow` | `Workflow` | `{label,iteration,phaseCurrent,phaseTotal,subagents,tasks}` identical |
| `lastPrompt`/`lastReply` | `LastPrompt`/`LastReply` | — |
| `errorCount` | `ErrorCount` | — |
| `lastStopReason` | `LastStopReason` | — |
| `startedAt`/`updatedAt` | `StartedAt`/`UpdatedAt` | ms epoch |
| `pid` | `PID` | liveness |

The send-on-change rule (§8.6) is exactly the reference `snapshot.Differ` behavior
(`meaningfullyDifferent` zeroes `UpdatedAt` before `reflect.DeepEqual`).

> **Convergence note.** Where the running backend's JSON differs from this spec (`stopped`
> vs. `ended`; flat `costUSD` vs. `cost.usd`; `aiTitle` vs. `title`), the spec is the target
> and the backend adds a thin compatibility shim at ingest until it converges. New adapters
> code to **this document**.

---

## Appendix A — A complete `waiting` round-trip

```
adapter → server   status   { status:"waiting", waiting:{kind:"approval",
                              text:"Run Bash xcodebuild?", options:["yes","no"]} }
server  → device   ui       waiting_prompt template (Commander-internal)
device  → server   input    { choice:"yes" }              (Commander-internal)
server  → adapter  cmd      { cmdId:"3f9c…", intent:"answer", answer:"yes" }
adapter → agent    (returns "yes" from the blocking permission hook)
adapter → server   ack      { cmdId:"3f9c…", status:"delivered", detail:"hook approved" }
adapter → server   status   { status:"busy", … }          (agent resumes)
```

Only the `status`/`cmd`/`ack` rows are ACAP; the `ui`/`input` rows are Commander↔device and
out of scope here, shown for context.

---

*ACAP 1.0 · part of Agent Commander · see [README](./README.md) ·
[conformance](./conformance.md) · [registry](./registry.md) ·
[adapter skeleton](./adapters/SKELETON.md)*
