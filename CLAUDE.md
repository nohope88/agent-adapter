# Agent Adapter — context for a continuing agent

Read this first, then `ARCHITECTURE.md` for the deep dive and `README.md` for end-user usage.
The canonical spec is **ACAP** (`docs/spec/ACAP.md` + `docs/spec/schemas/`, authoritative); this repo implements an ACAP **adapter** (the client side). The live reference Commander is `https://commander-api.autonomous.ai` (swagger at `/swagger/index.html`).

## What this is (and is NOT)
- **IS:** a headless, cross-platform process that **listens** to local AI coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, Hermes) and reports the canonical status (`idle/busy/waiting/error/ended`) per session, and **reacts back** (answer an approval, confirm, prompt, interrupt). It is an **ACAP client** that can uplink to a Commander.
- **IS NOT:** the Commander (cloud relay / multi-tenant auth / DB) — out of scope, we are only its client. No web dashboard server. No voice/STT/ESP32. Those are Commander/device concerns in the ACAP spec, deliberately **not built here**. Don't add them unless asked.

## Current status — session handoff (built 2026-06-11; ACAP/Commander uplink rewritten 2026-06-12)
**The whole adapter is built, compiles clean, 120 tests pass at 100% line coverage, CI is wired. It has NOT been committed to git or run against this machine's real agents/Commander yet.**

**2026-06-12 — uplink realigned to the live ACAP spec + Commander swagger** (the old code targeted the now-removed `docs/design.html`): REST `register` → `wsToken` → WS (subprotocol bearer) → `hello` gate → `ping`/`pong` → reconnect-re-registers; canonical status renamed (`working→busy`, `activeTool→activeTools[]`, `lastResponse→lastReply`, `select→choice`, `ts(string)→updatedAt(ms)`); cmd `cmdId` dedup; `toWireStatus` serializer. New `commanderClient.ts`. Default Commander `https://commander-api.autonomous.ai`. See the two open questions under "Other known gaps".

Done & verified:
- Full TypeScript codebase under `src/` — `npm run build` compiles with zero errors.
- `node dist/cli.js verify` → all 6 adapters pass conformance.
- `npm test` → **120 tests pass**; `npm run test:coverage` → **100% line coverage**. `npm run ci` reproduces the GitHub Actions gate and ran green locally.
- `.github/workflows/ci.yml` runs build + verify + test on macOS/Linux/Windows × Node 22 & 24 on push & PR.
- Smoke-tested live: inject a waiting session → roster shows `waiting` → `answer` → `rejected: no inject target` (correct — no real terminal bound) → capability gate works. Auto-detects whichever of `~/.claude ~/.codex ~/.cursor ~/.gemini …` exist.

Pick up here (NOT done):
- **Not a git repo yet.** To enable CI: `git init && git add -A && git commit -m "init" && git remote add origin <url> && git push -u origin main`. `node_modules/` and `dist/` are gitignored. CI fires on push. `ci.yml` triggers on **any branch** (`branches: ["**"]`) — narrow it if you only want main/PRs.
- **`install` has never been run on this machine** — it edits the real `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`. For dev use the isolated seed-credential + dead-Commander + `POST /ingest` flow (below), not `install`.
- gemini & hermes are **L0** (process-baseline); openclaw is a coarse file-mtime poll — see "Current state — verified vs TODO".
- managed-`node-pty` inject is not wired (only tmux send-keys); hosted `curl|bash` binary is a stub. `login --token <cmdr_ak_…>` stores + (when an http(s) `--commander` is given) verifies a tenant key; the live uplink hasn't been run against a real Commander yet.

## Decisions log (why it's built this way — don't re-litigate without reason)
- **Scope = the adapter only** (ACAP client). No Commander, no web dashboard server, no voice/ESP32 — user-confirmed across the planning conversation.
- **Observe + react-back** (ACAP L0–L2): report `idle/busy/waiting/error/ended` and send `answer/confirm/prompt/interrupt` back. "React" meant *react back to the agent*, not React.js.
- **TypeScript/Node, not Go** — react-back needs cross-platform pty incl. Windows (node-pty/ConPTY) and the listen side is a tiny local socket, so one language end-to-end wins. (ACAP itself is language-agnostic; the reference Commander is Go.)
- **Listen via hooks→socket** (oc-claw's model), not file-tailing: lower latency and hands us `waiting` directly; file-poll only for OpenClaw. Reference: oc-claw (github.com/rainnoon/oc-claw) — its `CLAUDE.md` is the source for the hook formats + pitfalls encoded in `statemachine.ts`/`binding.ts`/`installer.ts`.
- **Commander is not ours** — the adapter is its ACAP *client*: REST `register` ▸ `wsToken` ▸ WS (`hello`/status▲/cmd▼/ack/ping-pong). **`start` now requires login** (a stored `cmdr_ak_` tenant key) — there is no `--local` mode. (The Hub *can* be constructed with no credential, which disables the uplink — that's the test/dev escape hatch, not a user mode.)

## Golden rules (do not break these)
1. **Hooks fail-open.** The hook path (`hookClient.ts`) must never block or break the agent if the hub is down. Keep the tight timeouts; always `exit 0`.
2. **Session-keyed everything.** State, binding, roster key on `kind:host:sessionId`. Never collapse multiple sessions of one agent into one.
3. **`source` is upgrade-only; never overwrite a field with an empty value.** (oc-claw pitfalls #2/#3 — see `statemachine.ts`.) Cursor + CC fire for the same session; cursor must win and CC's empty `cwd` must not clobber.
4. **Never use Cursor's pid** for binding/identity — it's ephemeral (oc-claw pitfall #1). Bind Cursor by workspace/port/native-handle (`binding.ts`).
5. **Capability gate before inject.** `hub.handleCommand` rejects intents an adapter doesn't declare. Don't route around it.
6. **Tenant/Commander is not ours.** We only hold a credential and speak ACAP. Don't add server-side auth/DB here.
7. **Schema is versioned (`v`).** New fields are additive + optional. Don't rename/remove wire fields in `protocol.ts` without bumping.
8. **`acap-verify` must stay green.** Run it after any adapter change: `node dist/cli.js verify`.

## Build / run / test
```bash
npm install            # Node >= 22 required (uses the global WebSocket)
npm run build          # tsc → dist/  (must be zero errors)
node dist/cli.js verify   # acap-verify all adapters (exit 0 = green)
npm test               # functional unit + hub integration tests (node:test, no extra deps)
npm run test:coverage  # same tests + a 100%-LINE-coverage gate on the core library modules
npm run ci             # build + verify + test:coverage — the strict local gate (run before pushing)
```
**CI:** `.github/workflows/ci.yml` runs `npm test` (functional) across macOS/Linux/Windows × Node 22/24, plus a Linux-only `coverage` job that runs `npm run test:coverage`. Keep both green — add a test under `src/__tests__/` for any new core logic.

**Coverage gate (honest 100% line):** enforced on the *library* modules only (statemachine, store, ingest, hub, runtime, hookClient, installer, injector/index, util/*, adapters/registry + descriptors, protocol, binding, acapVerify). Deliberately **excluded** (see `package.json` `test:coverage` `--test-coverage-exclude`): the process entrypoint `cli.ts` and the OS-spawning leaves `installer-daemon.ts`, `injector/pty.ts`, `adapters/process-fallback.ts`, `adapters/codex`, `adapters/openclaw` — these spawn real daemons/ptys/processes and are validated by the integration & subprocess tests, not line %. Gate runs on Linux because some library modules have platform-divergent branches (POSIX unix-socket vs Windows TCP) that can't both be hit on one OS. Prefer a real test over a `node:coverage ignore`; there are currently **zero** such directives in the tree.
**Isolated smoke test (no real agent configs touched).** `start` now requires login, so seed a credential and point the uplink at a dead/local Commander — the hub boots and the control API works while the uplink just retries in the background:
```bash
export AGENT_ADAPTER_HOME=$(mktemp -d) AGENT_ADAPTER_CONTROL_PORT=7799
export AGENT_ADAPTER_COMMANDER=http://127.0.0.1:1     # nothing listening → uplink no-ops
node dist/cli.js login --token cmdr_ak_test           # seed a credential (no network: verify only runs for http(s) --commander)
node dist/cli.js start &                               # boot hub (uplink retries in background, harmless)
P=7799
curl -s 127.0.0.1:$P/healthz
# inject a fake waiting session over the HTTP /ingest test endpoint:
curl -s -X POST 127.0.0.1:$P/ingest -H 'content-type: application/json' \
  -d '{"v":1,"kind":"claude-code","event":"PreToolUse","sessionId":"s1","cwd":"/tmp/r","tool":"AskUserQuestion","toolInput":{"question":"Run tests?","options":["yes","no"]},"title":"demo"}'
curl -s 127.0.0.1:$P/agents          # → roster shows status:"waiting"
curl -s -X POST 127.0.0.1:$P/command -d '{"agentId":"claude-code:'"$(hostname -s)"':s1","intent":"answer","answer":"yes"}'
pkill -f 'dist/cli.js start'
```
> ⚠️ **Do NOT run `node dist/cli.js install` casually** — it edits the real `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`. Use the isolated seed-credential + dead-Commander + `/ingest` flow above for development. (To exercise the real uplink, log in with a genuine `cmdr_ak_` key against `https://commander-api.autonomous.ai`.)

## Where things live (each file owns one concern)
| File | Owns |
|---|---|
| `src/protocol.ts` | wire contract: `AgentStatus`, `Command`, `Ack`, `HookEvent`, `Register`/`RegisterResponse`/`Hello`, envelope, `toWireStatus` serializer. Mirrors `docs/spec/schemas/`; **schemas are authoritative**. |
| `src/commanderClient.ts` | Commander REST: `register()` (`POST /v1/agents/register`), `verifyKey()`. `DEFAULT_COMMANDER`. |
| `src/statemachine.ts` | normalized event → `idle/busy/waiting/error/ended`; `WAITING_TOOLS`, status priority, the two oc-claw guards. |
| `src/store.ts` | one snapshot per session, visible-change throttle, TTL prune. |
| `src/binding.ts` | session → inject target (pid/tty/workspace/native-handle). |
| `src/ingest.ts` | local socket server (unix; TCP `127.0.0.1:19284` on Windows). Events in, gate decision out. |
| `src/injector/` | `index.ts` dispatch · `pty.ts` (tmux/managed) · `hookReturn.ts` (staged decisions) · `nativeApi.ts`. |
| `src/adapters/<kind>/` | one `AdapterDescriptor` + `manifest.json` per agent. |
| `src/adapters/process-fallback.ts` | running-process → working/idle baseline for kinds with no hooks/poll. |
| `src/adapters/registry.ts` | `ALL_ADAPTERS`, `detected()`, `fallbackKinds()`. **Add a provider here.** |
| `src/runtime.ts` | ACAP uplink: one `KindConn` per kind — REST register → WS (subprotocol bearer) → `hello` gate → status▲ (coalesced/truncated) / cmd▼ (deduped) / ack / ping-pong → reconnect re-registers. `Uplink` fans out by kind. No credential ⇒ no-op sink. |
| `src/hub.ts` | wires ingest+store+binding+injector+uplink+fallback+pollers; local control HTTP API; single-instance lock. |
| `src/hookClient.ts` | the `hook` subcommand each agent invokes; normalizes per-kind payloads → `HookEvent`. |
| `src/hooks/installer.ts` | detect agents, merge hooks per format, register daemon, credentials. |
| `src/acapVerify.ts` | static conformance check of descriptors. |
| `src/cli.ts` | entrypoint; subcommands **lazy-require** deps so `hook` stays fast. |

## Conventions (match these)
- **CommonJS output** (`tsconfig` module=CommonJS) so `node dist/...` runs with extensionless requires. **No top-level `await`** — use an async `main()`.
- **Lazy `await import(...)` inside CLI command handlers** (not top-level) — keeps the hot `hook` path from loading the whole hub.
- **Loose WebSocket typing**: Node ≥22 has a global `WebSocket` but no lib types — `runtime.ts` types the socket as `any` on purpose. Don't pull in the DOM lib.
- Logging via `util/log.ts` (`logger(scope)`); paths/dirs via `util/paths.ts` (everything under `~/.agent-adapter`, overridable with `AGENT_ADAPTER_HOME`).
- Keep it surgical and simple (Karpathy house rules). No speculative abstractions; an adapter is a mapping, not a framework.

## Event → status mapping (the core contract)
Canonical events: `SessionStart · UserPromptSubmit · PreToolUse · PostToolUse · PermissionRequest · Notification · Stop · SessionEnd`.
- `PreToolUse(AskUserQuestion/AskQuestion)` **or** `PermissionRequest` **or** `Notification` → **waiting** (+ `waiting{text,options}`).
- tool running / prompt submitted → **busy**; `Stop` → **idle**; `SessionEnd` → **ended**.
- priority `waiting > error > busy > idle > ended`. (Canonical enum: `idle|busy|waiting|error|ended`; `waiting.kind ∈ approval|input|choice`.)
Each adapter's `hooks.events` maps that agent's **native** event names → these canonical ones; the hook command passes the canonical name, and `hookClient.normalize()` maps per-kind payload fields (`session_id` vs `conversation_id`, Cursor's `command`/`file_path`, etc.).

## How to add / upgrade an agent provider
1. `src/adapters/<kind>/manifest.json` + `index.ts` exporting an `AdapterDescriptor` (copy `claude-code/` as the template).
2. Set `detectDir`, `capabilities`, `provides`, `inject` (`{channel:'pty'|'native'|'none', hookReturn}`), and either `hooks` (config path + format + native→canonical event map) or a `poll(emit)`.
3. Add it to `ALL_ADAPTERS` in `registry.ts`. Run `node dist/cli.js verify`.
4. Hook config formats the installer knows: `'claude'` (`settings.json` `hooks.{Event}[].hooks[]`), `'codex'` / `'cursor'` (`hooks.json` `hooks.{Event}[].command`). Add a new format only in `installer.ts:entryFor/mergeHooks`.

## Current state — verified vs TODO
**Rich + hook-wired (formats confirmed from oc-claw `docs` lineage):** claude-code, codex, cursor.
**L0 / baseline (open work, clearly marked in each `manifest.json`):**
- `gemini` — no confirmed hook format. **TODO:** verify Gemini CLI's hook/settings mechanism, add a `hooks` recipe.
- `hermes` — daemon. **TODO:** wrap its control socket/RPC as a `poll` (status) + `controlEndpoint` (inject); then raise level past L0.
- `openclaw` — coarse session-file mtime poll. **TODO:** subscribe to its native event stream + set the real native control `controlEndpoint`.

**Other known gaps / next steps:**
- **Managed-pty injection not wired.** `injector/pty.ts` supports tmux send-keys + a `registerManaged` hook, but nothing spawns agents under a `node-pty` (optional dep, installed but unused). Without tmux, terminal-agent inject returns `no inject target`. Wire a "managed" launch mode to fix.
- **hook-return is best-effort/synchronous.** A staged answer is delivered only if the gate event is still open (`hookReturn.gateFor`). The reliable path today is pty. A deferred/blocking gate would make hook-return answer post-hoc.
- **Hosted installer/binary not set up.** `install.sh`/`install.ps1` build from source. For the `curl | bash` one-liner, compile a self-contained binary (`bun build --compile`) and host both.
- **Live uplink untested against a real Commander.** The flow is built to `docs/spec/ACAP.md` + the swagger; needs one real `cmdr_ak_` tenant key to confirm two open questions: (a) **register granularity** — we register once per detected *kind* and stream many session `agentId`s over that connection; if the Commander rejects unregistered per-session agentIds, fall back to lazy per-session register; (b) **WS auth** — we use subprotocol `acap.v1.bearer.<wsToken>` (spec §4.3 option b); confirm the Commander accepts it (it MUST accept the `Authorization` header (a); (b) is MAY).

## Pointers
- **`docs/spec/ACAP.md`** (+ `docs/spec/schemas/`, `docs/spec/conformance.md`, `docs/spec/registry.md`) — the authoritative ACAP wire contract: §4 transport (register REST + WS), §5 envelope, §6 lifecycle (hello/heartbeat/reconnect), §7 register/capabilities, §8 status model, §9 cmd/ack, §11 levels, §14 close codes.
- **Commander** — `https://commander-api.autonomous.ai` (swagger `/swagger/index.html`, raw spec `/swagger/doc.json`). The adapter touches `POST /v1/agents/register`, `GET /v1/agent` (WS), `GET /v1/keys/verify`.
- oc-claw (github.com/rainnoon/oc-claw) — the reference for the hook+socket listen model and the per-agent hook formats / pitfalls baked into `statemachine.ts` and `installer.ts`.
