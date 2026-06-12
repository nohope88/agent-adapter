# Architecture

Deep dive for anyone modifying the internals. Pairs with `CLAUDE.md` (rules + file map) and the **ACAP spec** ([`docs/spec/ACAP.md`](docs/spec/ACAP.md) + `docs/spec/schemas/`), the wire contract this implements.

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
       (no credential ⇒ uplink is a no-op; the local pipeline still works)
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
One `KindConn` per detected kind (the swagger is one-token→one-register→one-WS); `Uplink` fans `sendStatus` out to the matching connection. Each `KindConn` runs the full ACAP lifecycle (spec §6):
- **No credential / no `commanderUrl`** → `sendStatus` is a no-op; the hub is fully functional locally. (There is no `--local` flag — the CLI `start` requires login; this no-op path is the test/dev escape hatch when the Hub is constructed without a credential.)
- **Register (REST)** → `POST /v1/agents/register` with `Authorization: Bearer <tenantKey>` (`commanderClient.ts`) → `{wsToken, wsUrl, expiresInSec, heartbeatSec}`.
- **Upgrade (WS)** → connect to `wsUrl` with subprotocol `acap.v1.bearer.<wsToken>` (spec §4.3 option b — the standard `WebSocket` can't set headers).
- **Hello gate** → MUST NOT send status before the server `hello`; it carries `accepted` / `heartbeatSec` / `minStatusIntervalMs`. On hello: **flush the full roster for this kind** (resync — ACAP keeps no retained state), then drain the offline buffer.
- **Heartbeat** → server `ping` → reply `pong`; no ping for 2×`heartbeatSec` → close+reconnect.
- **Send-rate** → `sendStatus` coalesces to the latest snapshot per `agentId` while offline, and to ≤ one per `minStatusIntervalMs` while connected (spec §8.6); each status goes through `toWireStatus` (drops internal keys, truncates previews).
- **Commands** → dedupe on `cmdId` (LRU, spec §9.3) → `onCommand` → `ack` (`delivered|rejected|nosession|duplicate`); the target agentId is the **envelope `id`**.
- **Reconnect** → exponential backoff (250ms→30s) + full jitter. Every reconnect **re-registers** (fresh `wsToken`), so a `4401`/expiry is handled by construction; a proactive timer re-registers before `expiresInSec`. Close codes per §14 (`4403` longer backoff, `4429` slow down, `4408`/`1011`/other reconnect).

## Edge-case matrix (where each is handled)
| Case | Code |
|---|---|
| Hub down when hook fires | `hookClient` tight timeout + `exit 0` (fail-open) |
| Uplink drop / resume | `runtime.ts` backoff+jitter, flush snapshot after `hello` |
| Status while offline | `runtime.ts` `buffer` coalesces latest-per-agent |
| Token expiry / `4401` | `KindConn` reconnect always re-registers (REST) for a fresh `wsToken`; proactive timer at `expiresInSec×0.8` |
| Duplicate command (at-least-once) | `runtime.rememberCmd` LRU on `cmdId` → `ack:"duplicate"` |
| Duplicate event (2 sockets) | `statemachine` `shouldUpgradeSource` (upgrade-only) |
| Empty field overwrite | `statemachine` `setIfPresent` |
| Out-of-order / clock skew | `store`/`statemachine` stamp `updatedAt` (ms) |
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
`HookEvent` (hook→hub) → `AgentStatus` (hub→up, serialized by `toWireStatus`) is the spine. `Command`/`Ack` is the down path. Registration is the REST `POST /v1/agents/register` (`Register` → `RegisterResponse`), answered by a server `Hello`. Everything on the WS is wrapped in `Envelope{v,type,id,ts,data}`, `type ∈ hello|status|event|ack|cmd|ping|pong`. The canonical status enum is `idle|busy|waiting|error|ended`; `waiting.kind ∈ approval|input|choice`. The schemas in `docs/spec/schemas/` are authoritative — bump `v` / add optional fields for evolution.

## Test surfaces
- `npm test` — unit tests (`src/__tests__/*.test.ts`, Node's built-in runner, no extra deps) covering `statemachine` (both oc-claw pitfalls + each event→status), `store` (throttle/roster), `binding` (cursor-pid guard), `hookReturn`, `acapVerify`, plus a **hub integration test** that boots the hub and drives `POST /ingest → GET /agents → POST /command`.
- `node dist/cli.js verify` — descriptor conformance (CI gate).
- seed-credential + dead-Commander + `POST /ingest` + `GET /agents` + `POST /command` — manual full pipeline without real agents or a live Commander (see `CLAUDE.md`).
- **CI:** `.github/workflows/ci.yml` runs build + verify + test on macOS/Linux/Windows × Node 22/24 on every push & PR. `npm run ci` reproduces it locally.
- **Gaps worth covering next:** `installer` hook-merge idempotency, `hookClient.normalize` per-kind field mapping, `runtime` offline-coalesce/reconnect.
