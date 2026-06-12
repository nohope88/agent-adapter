# ACAP — the Agent Commander Adapter Protocol

**An open standard so anyone can make any AI coding agent show up on an Agent Commander —
and be voice-/command-controllable — without backend changes.**

The Commander provides one interface; the community freely builds adapters against it. An
adapter is a *mapping, not a system*: normalize one agent into a canonical status model, accept
canonical commands. The transport, auth, reconnect, fan-out, speech-to-text, and the device are
all the Commander's job. ACAP is the contract at the seam between them.

```
   community adapters                    one open contract                  one backend
  ┌──────────────────┐                  ┌──────────────────┐               ┌────────────┐
  │ claude-code  L3  │                  │      ACAP 1.0     │               │            │
  │ codex        L1  │ ── status ─────► │  envelope         │ ── ingest ──► │ Commander  │
  │ openclaw     L3  │ ◄──── cmd ────── │  status / cmd /   │ ◄── route ─── │ (agnostic) │
  │ hermes       L2  │                  │  ack · handshake  │               │            │
  │ your agent   L0  │                  │  L0–L3 · registry │               └────────────┘
  └──────────────────┘                  └──────────────────┘
```

---

## Read in this order

| Document | What it is |
|----------|------------|
| **[ACAP.md](./ACAP.md)** | The normative spec. Transport, envelope, lifecycle, capability handshake, the canonical status model, commands/acks, versioning, security, error codes. Start here. |
| **[conformance.md](./conformance.md)** | The L0–L3 level definitions and the `acap-verify` harness contract — how an adapter self-certifies without touching production. |
| **[registry.md](./registry.md)** | The open adapter registry: manifest format + the one-PR-to-list governance. |
| **[adapters/SKELETON.md](./adapters/SKELETON.md)** | The practical on-ramp. Two functions, an afternoon to L0, and the five things every good adapter gets right. |
| **[schemas/](./schemas/)** | Machine-checkable JSON Schema for every message — the authoritative wire definition. |
| **[examples/](./examples/)** | Concrete sample messages for each type. |

---

## The five ideas in one screen

1. **Two functions, not a system.** Implement `Source` (produce canonical status) and `Sink`
   (apply a command). The shared `AdapterRuntime` does all networking.
2. **Declare, don't assume.** An adapter advertises its `level`, `capabilities` (intents it
   accepts) and `provides` (status fields it populates). The Commander tailors everything to
   that and degrades gracefully — *no capability is ever assumed*.
3. **Ship at L0, grow upward.** L0 Observer is read-only status in an afternoon. L1 adds
   `prompt`, L2 adds `answer`/`interrupt`/`mode`, L3 is full-fidelity.
4. **One canonical model.** Every agent maps into the same status shape — field-compatible with
   the reference Commander's `model.Session`. The backend never learns anything agent-specific.
5. **Additive forever.** Unknown fields/types/enums are ignored, not rejected. A 1.0 adapter and
   a 1.x Commander interoperate indefinitely.

## Conformance at a glance

| Level | Name | Adds | `capabilities` |
|-------|------|------|----------------|
| L0 | Observer | canonical status, read-only | `[]` |
| L1 | Promptable | + `prompt` | `["prompt"]` |
| L2 | Interactive | + `answer` · `interrupt` · `mode` | subset of all four |
| L3 | Rich | + structured tools · `todos` · per-message `cost` · `workflow` | as L2 |

## Message types

| `type` | Direction | Payload |
|--------|-----------|---------|
| `hello` | server → adapter | negotiated capabilities + connection limits |
| `status` | adapter → server | full snapshot of one agent |
| `event` | adapter → server | optional discrete notification |
| `ack` | adapter → server | result of a command |
| `cmd` | server → adapter | a command to deliver |
| `ping`/`pong` | both | server-initiated heartbeat |

All wrapped in one envelope: `{ "v":1, "type", "id", "ts", "data" }`.

---

## Status of this standard

ACAP **1.0 Draft** (2026-06-11). Descended from `agent-status`'s `SessionProvider` (one-way,
local, read-only) — ACAP adds the return path, the network, and the multi-tenant boundary while
keeping the lineage's hard-won insight: *the cheapest way to know what an agent is doing is to
read the state it already writes.* See the system context in
[`../design.html`](../design.html) (§07 adapter interface, §08 ACAP, §09 agent deep dives).

Relationship to the running backend: the canonical status model is field-compatible with
`commander/internal/model/model.go`; the send-on-change rule is exactly its `snapshot.Differ`.
Where the current backend JSON differs (`stopped`↔`ended`, `costUSD`↔`cost.usd`,
`aiTitle`↔`title`) the spec is the target and the backend shims at ingest until it converges —
see [ACAP.md §15](./ACAP.md). **New adapters code to the spec, not the current backend JSON.**

---

*Part of [Agent Commander](../design.html). Apache-2.0 / open — adapters may use any OSI license.*
