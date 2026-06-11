# Agent Adapter — context for a continuing agent

Read this first, then `ARCHITECTURE.md` for the deep dive and `README.md` for end-user usage.
The canonical spec is `docs/design.html` (the "Agent Commander" design); this repo implements **only Tier 1, the Agent Adapter**.

## What this is (and is NOT)
- **IS:** a headless, cross-platform process that **listens** to local AI coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, Hermes) and reports `working / idle / waiting` per session, and **reacts back** (answer an approval, confirm, prompt, interrupt). It is an **ACAP client** that can uplink to a Commander.
- **IS NOT:** the Commander (cloud relay / multi-tenant auth / DB) — out of scope, we are only its client. No web dashboard. No voice/STT/ESP32. Those exist in `docs/design.html` but are deliberately **not built here**. Don't add them unless asked.

## Current status — session handoff (built 2026-06-11)
**The whole adapter is built, compiles clean, 26 tests pass, CI is wired. It has NOT been committed to git or run against this machine's real agents yet.**

Done & verified:
- Full TypeScript codebase under `src/` — `npm run build` compiles with zero errors.
- `node dist/cli.js verify` → all 6 adapters pass conformance.
- `npm test` → **26 tests pass** (unit + hub integration). `npm run ci` reproduces the GitHub Actions gate and ran green locally including `npm ci --omit=optional`.
- `.github/workflows/ci.yml` runs build + verify + test on macOS/Linux/Windows × Node 22 & 24 on push & PR.
- Smoke-tested live: inject a waiting session → roster shows `waiting` → `answer` → `rejected: no inject target` (correct — no real terminal bound) → capability gate works. Auto-detects whichever of `~/.claude ~/.codex ~/.cursor ~/.gemini …` exist.

Pick up here (NOT done):
- **Not a git repo yet.** To enable CI: `git init && git add -A && git commit -m "init" && git remote add origin <url> && git push -u origin main`. `node_modules/` and `dist/` are gitignored. CI fires on push. `ci.yml` triggers on **any branch** (`branches: ["**"]`) — narrow it if you only want main/PRs.
- **`install` has never been run on this machine** — it edits the real `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`. For dev use the isolated `--local` + `POST /ingest` flow (below), not `install`.
- gemini & hermes are **L0** (process-baseline); openclaw is a coarse file-mtime poll — see "Current state — verified vs TODO".
- managed-`node-pty` inject is not wired (only tmux send-keys); hosted `curl|bash` binary and the `login` device-code flow are stubs.

## Decisions log (why it's built this way — don't re-litigate without reason)
- **Scope = the adapter only** (design.html Tier 1). No Commander, no web dashboard, no voice/ESP32 — user-confirmed across the planning conversation.
- **Observe + react-back** (ACAP L0–L2): report `working/idle/waiting` and send `answer/confirm/prompt/interrupt` back. "React" meant *react back to the agent*, not React.js.
- **TypeScript/Node, not Go** — overrides design.html §13. Reason: react-back needs cross-platform pty incl. Windows (node-pty/ConPTY) and the listen side is a tiny local socket, so one language end-to-end wins. Go was the doc's pick for a *headless, no-injection* binary.
- **Listen via hooks→socket** (oc-claw's model), not file-tailing: lower latency and hands us `waiting` directly; file-poll only for OpenClaw. Reference: oc-claw (github.com/rainnoon/oc-claw) — its `CLAUDE.md` is the source for the hook formats + pitfalls encoded in `statemachine.ts`/`binding.ts`/`installer.ts`.
- **Commander is not ours** — the adapter is its ACAP *client* (register/status▲/cmd▼/ack over WSS); `--local` runs the whole thing with no Commander.

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
npm test               # unit + hub integration tests (node:test, no extra deps)
npm run ci             # build + verify + test — exactly what GitHub Actions runs
```
**CI:** `.github/workflows/ci.yml` runs the above on every push/PR across macOS/Linux/Windows × Node 22/24. Keep it green — add a test under `src/__tests__/` for any new core logic.
**Isolated smoke test (no real agent configs touched):**
```bash
export AGENT_ADAPTER_HOME=$(mktemp -d) AGENT_ADAPTER_CONTROL_PORT=7799
node dist/cli.js start --local &        # boot hub in local mode
P=7799
curl -s 127.0.0.1:$P/healthz
# inject a fake waiting session over the HTTP /ingest test endpoint:
curl -s -X POST 127.0.0.1:$P/ingest -H 'content-type: application/json' \
  -d '{"v":1,"kind":"claude-code","event":"PreToolUse","sessionId":"s1","cwd":"/tmp/r","tool":"AskUserQuestion","toolInput":{"question":"Run tests?","options":["yes","no"]},"title":"demo"}'
curl -s 127.0.0.1:$P/agents          # → roster shows status:"waiting"
curl -s -X POST 127.0.0.1:$P/command -d '{"agentId":"claude-code:'"$(hostname -s)"':s1","intent":"answer","answer":"yes"}'
pkill -f 'dist/cli.js start'
```
> ⚠️ **Do NOT run `node dist/cli.js install` casually** — it edits the real `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`. Use the isolated `--local` + `/ingest` flow above for development. There is no Commander to test the uplink against; `--local` is the supported dev mode.

## Where things live (each file owns one concern)
| File | Owns |
|---|---|
| `src/protocol.ts` | wire contract: `AgentStatus`, `Command`, `Ack`, `HookEvent`, envelope, `Status`/`Intent`/`Level`. **Source of truth for the schema.** |
| `src/statemachine.ts` | normalized event → `working/idle/waiting`; `WAITING_TOOLS`, status priority, the two oc-claw guards. |
| `src/store.ts` | one snapshot per session, visible-change throttle, TTL prune. |
| `src/binding.ts` | session → inject target (pid/tty/workspace/native-handle). |
| `src/ingest.ts` | local socket server (unix; TCP `127.0.0.1:19284` on Windows). Events in, gate decision out. |
| `src/injector/` | `index.ts` dispatch · `pty.ts` (tmux/managed) · `hookReturn.ts` (staged decisions) · `nativeApi.ts`. |
| `src/adapters/<kind>/` | one `AdapterDescriptor` + `manifest.json` per agent. |
| `src/adapters/process-fallback.ts` | running-process → working/idle baseline for kinds with no hooks/poll. |
| `src/adapters/registry.ts` | `ALL_ADAPTERS`, `detected()`, `fallbackKinds()`. **Add a provider here.** |
| `src/runtime.ts` | ACAP uplink client: register, status▲, cmd▼/ack, reconnect/jitter, token refresh, offline coalesce. `--local` = no-op sink. |
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
- tool running / prompt submitted → **working**; `Stop` → **idle**; `SessionEnd` → **ended**.
- priority `waiting > error > working > idle > ended`.
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
- **Auth/login is a stub.** `login --token` stores a credential; there's no device-code flow (the Commander would own that).

## Pointers
- `docs/design.html` — the full system spec (Commander, tenancy, device, audio); §06 schemas, §07 adapter interface, §08 ACAP levels, §09 per-agent deep dives map directly to this code.
- oc-claw (github.com/rainnoon/oc-claw) — the reference for the hook+socket listen model and the per-agent hook formats / pitfalls baked into `statemachine.ts` and `installer.ts`.
