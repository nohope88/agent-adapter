# ACAP Conformance

How an adapter proves it conforms — the level definitions and the `acap-verify` harness.
Read [ACAP.md](./ACAP.md) first; this document is the test contract behind it.

The promise of ACAP is **self-certification without touching production**: run a mock
Commander against your adapter, pass the suite for a level, and you may claim that level in the
[registry](./registry.md). No human gatekeeper inspects your agent.

---

## 1. Conformance levels

Levels are cumulative: L2 includes everything in L1, etc. An adapter declares its level at
registration (§7 of ACAP.md); the level **MUST** match what it actually passes.

### L0 — Observer  (`capabilities: []`)

Read-only status. The afternoon on-ramp.

**MUST:**
- Register with a valid [register](./schemas/register.schema.json) body, `level:"L0"`,
  `capabilities:[]`.
- Complete the lifecycle: register → upgrade → wait for `hello` → stream `status`.
- Emit canonical [status](./schemas/status.schema.json) with at least the four required
  fields (`agentId`, `kind`, `status`, `updatedAt`) for every represented agent.
- Drive `status` through a realistic lifecycle: `idle → busy → (waiting|error)? → ended`.
- Honor the send-on-change gate (§8.6): no resend when only `updatedAt` changed; no faster
  than `minStatusIntervalMs`.
- Never stick at `busy` after the agent dies — emit `ended` via liveness/staleness (§8.5).
- Reconnect with backoff and resync all agents after a forced disconnect.
- Reply `pong` to `ping` within `heartbeatSec`.

**MUST NOT:** accept commands (it declared none); send before `hello`; send a field key it
didn't list in `provides`.

### L1 — Promptable  (adds `prompt`)

Everything in L0, plus accepting a fresh prompt.

**MUST:**
- Declare `capabilities` ⊇ `["prompt"]`.
- For a `cmd` with `intent:"prompt"`, inject it into the live agent and reply exactly one
  `ack` (`delivered`, or `nosession` if the agent is gone).
- Dedupe on `cmdId`: a redelivered prompt **MUST NOT** inject twice → `ack:"duplicate"`.
- Reflect the injected prompt in subsequent `status` (e.g. `status:"busy"`, updated
  `lastPrompt`).

### L2 — Interactive  (adds `answer`, `interrupt`, `mode` — any subset)

Everything in L1, plus closed-loop control. An adapter MAY support any subset and declares
exactly that subset.

**MUST (per declared intent):**
- `answer`: when the agent is `waiting`, deliver the chosen option/text and unblock it; reject
  with `reason:"bad-answer"` if the answer isn't a valid option.
- `interrupt`: cancel the current turn via a clean mechanism (signal/RPC), reflected as a
  return to `idle`/`ended` and (optionally) an `event:{name:"interrupted"}`.
- `mode`: switch permission mode and reflect the new value in `status.mode`.
- Reject any intent **not** declared with `ack:"rejected"`, `reason:"unsupported-intent"`.

### L3 — Rich  (full-fidelity status)

Everything in L2, plus a complete status mapping.

**MUST `provide` and populate** (when the agent exposes them): `activeTool`, `tokens`,
`context`, `cost`, `todos`, and `workflow` for non-`plain` sessions; structured tool
activity with `inputPreview`; correct cumulative-token de-duplication (§8.7).

---

## 2. `acap-verify` — the harness

`acap-verify` is a **mock Commander + a scripted scenario runner**. It stands up a local WSS
endpoint, plays the server side of ACAP, drives your adapter through scripted situations, and
validates every message your adapter emits against the JSON Schemas plus the behavioral rules
above.

```
acap-verify ./adapters/youragent --level L2
```

It is the single source of truth for "does this conform." A green run is what you cite in your
registry PR.

### 2.1 What it does

1. **Boots a mock Commander** on `wss://127.0.0.1:<port>/v1/agent` with a throwaway CA the
   harness hands your adapter (so TLS verification stays *on* — you point the adapter at the
   harness CA, you don't disable verification).
2. **Serves registration** at `POST /v1/agents/register`, issuing a short-lived token, and
   records the register body for schema + consistency checks (level ↔ capabilities ↔ provides).
3. **Sends `hello`**, then **schema-validates every inbound envelope** against
   [`schemas/`](./schemas/). Any envelope that fails its schema (and isn't a legitimately
   ignorable unknown `type`) fails the run.
4. **Runs scenarios** (§2.2): feeds your adapter a fixture agent lifecycle and/or drives
   commands down, asserting the expected `status`/`ack` come back.
5. **Exercises resilience**: forces a disconnect mid-stream and asserts backoff + full resync;
   withholds `ping` to confirm your client reconnects; sends a duplicate `cmdId` to confirm
   dedup; sends an unsupported `intent` to confirm graceful `rejected`; sends an unknown
   `type`/unknown field to confirm you *ignore* rather than crash.
6. **Emits a report**: per-check pass/fail, the negotiated level actually demonstrated, and a
   machine-readable `acap-verify.json` you attach to the registry PR.

### 2.2 Fixtures and the "agent side"

`acap-verify` cannot know how to drive *your* agent, so it works in one of two modes:

- **Fixture mode (recommended for CI):** you ship a `fixtures/` dir — a recorded sequence of
  raw agent observations (the jsonl/log/event stream your adapter consumes). The harness replays
  them into your adapter's *input* and asserts on its *ACAP output*. This makes conformance
  reproducible and offline.
- **Live mode:** you point the adapter at a real agent and the harness asserts on the wire only.
  Useful for a final smoke test; not deterministic enough for CI gating.

A conformant adapter SHOULD provide fixtures covering: a clean `idle→busy→ended` run, a
`waiting` approval, an `error`, and a hard-kill (no stop signal → liveness `ended`).

### 2.3 Check catalogue (what each level must pass)

| Check | L0 | L1 | L2 | L3 |
|-------|----|----|----|----|
| Register body valid + level/caps/provides consistent | ✓ | ✓ | ✓ | ✓ |
| Waits for `hello` before sending | ✓ | ✓ | ✓ | ✓ |
| Every envelope schema-valid | ✓ | ✓ | ✓ | ✓ |
| Required status fields present | ✓ | ✓ | ✓ | ✓ |
| `provides` ⊇ every field key actually sent | ✓ | ✓ | ✓ | ✓ |
| Send-on-change gate (no `updatedAt`-only resend) | ✓ | ✓ | ✓ | ✓ |
| `minStatusIntervalMs` respected | ✓ | ✓ | ✓ | ✓ |
| Liveness: no stuck `busy` after kill | ✓ | ✓ | ✓ | ✓ |
| Reconnect + full resync after forced drop | ✓ | ✓ | ✓ | ✓ |
| `pong` within `heartbeatSec` | ✓ | ✓ | ✓ | ✓ |
| Ignores unknown `type`/fields (no crash/close) | ✓ | ✓ | ✓ | ✓ |
| `prompt` injected + single `ack` | | ✓ | ✓ | ✓ |
| `cmdId` dedup → `duplicate` | | ✓ | ✓ | ✓ |
| Declared `answer`/`interrupt`/`mode` behave | | | ✓ | ✓ |
| Undeclared intent → `rejected:unsupported-intent` | | | ✓ | ✓ |
| `waiting` carries structured `{kind,text,options}` | | | ✓ | ✓ |
| Full status mapping (`tokens`/`context`/`cost`/`todos`/`workflow`) | | | | ✓ |
| Cumulative-token de-duplication correct | | | | ✓ |

A run claims the **highest level whose entire column is green**. Passing some L2 checks but not
all → certified L1.

### 2.4 Exit + report

- Exit `0` only if the requested `--level` column is fully green.
- Writes `acap-verify.json`:

```json
{
  "acap": "1.0",
  "adapter": "youragent",
  "requestedLevel": "L2",
  "certifiedLevel": "L2",
  "checks": [ { "id": "status.required-fields", "level": "L0", "pass": true }, "…" ],
  "harnessVersion": "acap-verify/1.0.3",
  "passedAt": "<filled by CI>"
}
```

(The harness does not stamp wall-clock itself; CI injects `passedAt`.)

---

## 3. Commander-side conformance

A Commander is conformant if it:

- Accepts any adapter registering at any level with **no agent-specific code path**.
- Derives tenant solely from the credential; ignores any tenant id in payloads.
- Sends exactly one `hello`; never sends an `intent` outside the adapter's `accepted.capabilities`.
- Routes/render-decides purely from `status` + `provides` (degrades when a field is absent).
- Redelivers commands only with a stable `cmdId` (so adapter dedup works).
- Implements the send-on-change differ semantics on ingest (idempotent to duplicate `status`).

`acap-verify --commander wss://your-backend/v1/agent` runs the **mirror image**: a mock adapter
that probes the Commander for each of these.

---

*ACAP 1.0 · [spec](./ACAP.md) · [registry](./registry.md) · [adapter skeleton](./adapters/SKELETON.md)*
