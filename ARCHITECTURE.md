# Architecture

Deep dive for anyone modifying the internals. Pairs with `CLAUDE.md` (rules + file map) and `docs/design.html` (the spec this implements — Tier 1 only).

## Data flow

```
  AGENTS (many sessions, many kinds, this machine)
   claude-code · codex · cursor · gemini · openclaw · hermes
        │ installed hooks push events           ▲ STATUS UP
        ▼ unix socket / win tcp 127.0.0.1:19284  │ (real-time)
  ┌──────────────────────────────────────────────────────────┐
  │  HUB  (hub.ts)                                            │
  │   ingest.ts ──▶ binding.learn(ev)                        │
  │             ──▶ store.apply(ev) ──▶ statemachine.reduce  │
  │                      │ visible change?                    │
  │                      ├─▶ uplink.sendStatus(s)  (ACAP ▲)   │
  │                      └─▶ control SSE / roster             │
  │                                                          │
  │   command ▼ (from uplink OR local control API)           │
  │     hub.handleCommand → capability gate → injector       │
  │        injector/index.ts dispatch:                       │
  │          channel 'native' → nativeApi.ts                 │
  │          channel 'pty'    → pty.ts (tmux/managed)        │
  │          + hookReturn.stage() for answers                │
  │        → Ack                                             │
  └───────────────────────────┬──────────────────────────────┘
                              │ ACAP over WSS (optional)
                              ▼
                   [ Commander ] — not in this repo
              (`--local` ⇒ uplink is a no-op; everything still works)
```

Green/up = status; amber/down = commands. The two directions share `protocol.ts` shapes and the `Envelope`.

## Lifecycle of a status event
1. An agent fires a native hook (e.g. Claude `PreToolUse`). The installed entry runs `agent-adapter hook --kind claude-code --event PreToolUse`.
2. `hookClient.runHook` reads the agent's JSON on stdin, `normalize()`s it (per-kind field map) into a `HookEvent`, opens the ingest socket, writes one line, and — for gate-class events — waits ≤800ms for a decision to echo on stdout (else neutral default). Always `exit 0`.
3. `ingest.ts` parses the line, runs the optional `gate()` (→ `hookReturn.gateFor`) and calls `onEvent`.
4. `hub.onEvent` → `binding.learn(ev)` (records inject target) + `store.apply(ev)`.
5. `store.apply` → `statemachine.reduce(prev, ev)` produces the next per-session snapshot. If a **visible** field changed, listeners fire: `uplink.sendStatus` (up) and the SSE/roster broadcast.

Process-baseline path (gemini/hermes, and any non-hook kind): `process-fallback.ts` polls `ps`/`tasklist` every 3s and synthesizes `SessionStart`/working(`UserPromptSubmit`)/idle(`Stop`)/`SessionEnd` events into the same `onEvent` pipeline. OpenClaw's `poll` does the same from session-file mtimes.

## Lifecycle of a command (react back)
1. Command arrives via the uplink (`cmd` envelope) or the local control API (`POST /command`). Both funnel into `hub.handleCommand`.
2. Resolve adapter by `kind` (first segment of `agentId`). **Capability gate:** reject if `intent ∉ adapter.capabilities`.
3. `injector.dispatch(cmd, adapter.inject)`:
   - resolve the inject target from `binding`; if none and channel ≠ `none` → `Ack{nosession}`.
   - `answer` + `hookReturn` → stage a decision (clean path if a gate is still open).
   - `channel 'native'` → POST to `controlEndpoint`. `channel 'pty'` → `typeText` (answer/prompt) or `sendKey(Esc)` (interrupt) via tmux send-keys or a managed pty.
   - no target → `Ack{rejected, "no inject target"}` (never throws/crashes).
4. `Ack` returns to the caller (control API response, or `ack` envelope up the uplink).

## Uplink (runtime.ts) — resilience
- **`--local` / no `commanderUrl`** → `sendStatus` is a no-op; the hub is fully functional locally.
- **Connect** → send `register` per adapter (level + capabilities + provides), then **flush the full roster** (replaces "retained" messages), then drain the offline buffer.
- **While disconnected** → `sendStatus` coalesces to the **latest snapshot per `agentId`** (no unbounded queue).
- **Reconnect** → exponential backoff (1s→30s) + jitter.
- **Auth** → token via `?token=` query; on close `4401/1008` call `credential.refresh()` then reconnect.

## Edge-case matrix (where each is handled)
| Case | Code |
|---|---|
| Hub down when hook fires | `hookClient` tight timeout + `exit 0` (fail-open) |
| Uplink drop / resume | `runtime.ts` backoff+jitter, flush snapshot on open |
| Status while offline | `runtime.ts` `buffer` coalesces latest-per-agent |
| Token expiry | `runtime.onClose` 4401/1008 → `credential.refresh` |
| Duplicate event (2 sockets) | `statemachine` `shouldUpgradeSource` (upgrade-only) |
| Empty field overwrite | `statemachine` `setIfPresent` |
| Out-of-order / clock skew | `store`/`statemachine` server-stamp `ts` |
| Crashed session, no Stop | `store.startPrune` TTL → `ended` → drop |
| Cursor ephemeral pid | `binding.learn` ignores pid when `kind==='cursor'` |
| No inject target | `injector` → `Ack{rejected,'no inject target'}` |
| Unsupported intent | `hub.handleCommand` capability gate |
| Double install | `util/lock.acquireSingleInstance` pidfile |

## Local control API (hub.ts)
`http://127.0.0.1:7788` (override `AGENT_ADAPTER_CONTROL_PORT`):
- `GET /healthz` · `GET /agents` (roster) · `GET /stream` (SSE)
- `POST /command` `{agentId, intent, answer|prompt|mode}` → `Ack`
- `POST /ingest` `{HookEvent}` — **test affordance**: inject an event without a real hook.

## Protocol (protocol.ts) is the contract
`HookEvent` (hook→hub) → `AgentStatus` (hub→up) is the spine. `Command`/`Ack` is the down path. `Register` is the handshake. Everything is wrapped in `Envelope{v,type,id,ts,data}` on the wire. Bump `v` for breaking changes; add fields as optional.

## Test surfaces
- `npm test` — unit tests (`src/__tests__/*.test.ts`, Node's built-in runner, no extra deps) covering `statemachine` (both oc-claw pitfalls + each event→status), `store` (throttle/roster), `binding` (cursor-pid guard), `hookReturn`, `acapVerify`, plus a **hub integration test** that boots the hub and drives `POST /ingest → GET /agents → POST /command`.
- `node dist/cli.js verify` — descriptor conformance (CI gate).
- `--local` + `POST /ingest` + `GET /agents` + `POST /command` — manual full pipeline without real agents (see `CLAUDE.md`).
- **CI:** `.github/workflows/ci.yml` runs build + verify + test on macOS/Linux/Windows × Node 22/24 on every push & PR. `npm run ci` reproduces it locally.
- **Gaps worth covering next:** `installer` hook-merge idempotency, `hookClient.normalize` per-kind field mapping, `runtime` offline-coalesce/reconnect.
