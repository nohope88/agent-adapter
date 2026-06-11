# Agent Adapter

Listen to local AI coding agents (**Claude Code · Codex · Cursor · Gemini CLI · OpenClaw · Hermes**) in real time — `working / idle / waiting` — and **react back** (answer an approval, confirm, prompt, interrupt).

This is **Tier 1 (the Agent Adapter)** from `design.html`. It is an **ACAP client**: it can uplink to a Commander you run elsewhere, but the **Commander is not included** here. It also runs fully standalone with `--local`.

> Scope: the adapter only. No cloud Commander, no web dashboard, no voice/ESP32 (those are deferred from the design doc).

---

## How it works

```
 agents → installed hooks ──(socket)──▶ HUB ──(WSS uplink, optional)──▶ Commander
   ▲ status (working/idle/waiting)        │ state machine + binding         (not ours)
   ▼ react back (answer/confirm/…)        │ injector + control API
                                          └─ CLI: status · answer · prompt · interrupt
```

1. **Listen** — `install` writes a tiny hook into each detected agent (Claude `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Cursor `~/.cursor/hooks.json`). On every event the hook posts JSON to a **local socket** (unix socket; TCP `127.0.0.1:19284` on Windows). Agents without a usable hook system get a **process-baseline** (running + CPU% → working/idle).
2. **State** — events fold into one snapshot **per session** (`kind:host:sessionId`); `PreToolUse(AskUserQuestion)` / `PermissionRequest` / `Notification` → **waiting**.
3. **React back** — a command for a waiting session is delivered via **hook-return** (answer a permission inline) or **pty / tmux send-keys** (type the choice / prompt / `Esc`), or a **native control endpoint** (OpenClaw/Hermes).
4. **Uplink** — optionally streams status up and accepts commands down over one WSS to a Commander, with reconnect, token refresh, and offline coalescing. Omit it and everything still works locally.

---

## Install

**One-liner** (needs Node ≥ 22 and `git`). The script clones the repo into `~/.agent-adapter/src`, builds, and installs:

```bash
# macOS / Linux
curl -fsSL https://nohope88.github.io/agent-adapter/install.sh | bash
```
```powershell
# Windows (PowerShell)
irm https://nohope88.github.io/agent-adapter/install.ps1 | iex
```

**From a checkout** (same script, run locally):

```bash
git clone https://github.com/nohope88/agent-adapter && cd agent-adapter
./install.sh          # macOS / Linux
.\install.ps1         # Windows (PowerShell)
```

Either way it builds, **detects** installed agents, **wires their hooks**, and registers a background daemon (launchd / systemd-user / Scheduled Task). Re-runnable (a second run fetches latest + re-wires). Uninstall from a checkout with `./install.sh --uninstall` (`.\install.ps1 --uninstall` on Windows).

---

## Use

```bash
agent-adapter start --local          # run the hub locally (no Commander)
agent-adapter start --commander wss://your-commander/agent   # with uplink
agent-adapter status                 # live roster
agent-adapter answer claude-code:host:SID yes     # react to a waiting agent
agent-adapter prompt claude-code:host:SID "run the tests again"
agent-adapter interrupt claude-code:host:SID
agent-adapter detect                 # which agents are present
agent-adapter verify                 # acap-verify all adapters
agent-adapter login --token <t> --commander wss://…   # store a Commander credential
```

`status`/`answer`/etc. talk to the running hub's local control API (`http://127.0.0.1:7788`).

---

## Agent support (honest matrix)

| Agent | Status | React-back | State source |
|---|---|---|---|
| **Claude Code** | rich (`working/idle/waiting`, tool, title) | pty/tmux + hook-return | hooks ✓ verified |
| **Codex** | rich | pty + hook-return | hooks ✓ |
| **Cursor** | rich | hook-return (permission gating) | hooks ✓ (bind by workspace, never pid) |
| **Gemini CLI** | working/idle | pty best-effort | **process-baseline** — hook format TODO |
| **OpenClaw** | working/idle | native control API | session-file poll; native event stream TODO |
| **Hermes** | working/idle | native control API | **process-baseline** — control socket TODO |

The three "TODO" rows ship at **L0** today and are designed to upgrade in place — see "Add a provider."

---

## Edge cases handled

- **Reconnect:** uplink backoff+jitter; on reconnect push the **full snapshot**; token refresh on `4401/1008`; offline → coalesce latest-per-session and flush.
- **Hooks fail-open:** the hook posts with a tight timeout and never blocks the agent if the hub is down.
- **Commands:** `cmdId`+ack, capability gate, `nosession` / `no inject target` rejects (never a crash).
- **Sessions:** keyed by id; source **upgrade-only** + empty-field guard (oc-claw pitfalls); stale sessions pruned by TTL.
- **Inject targeting:** bind by pid/tty/workspace/native-handle; **never** Cursor's ephemeral pid.
- **Process:** single-instance pidfile lock; daemon auto-restart via the OS service.

---

## Add a provider — "one folder"

```
src/adapters/<kind>/
  manifest.json     # id, level, maintainer, notes
  index.ts          # an AdapterDescriptor: capabilities, provides, inject, detectDir, hooks?/poll?
```

Then add it to `src/adapters/registry.ts` and run `agent-adapter verify`. Ship at **L0** (status only) immediately; add a `hooks` recipe or `poll` to grow to L1–L3. `acap-verify` enforces the descriptor is well-formed.

---

## Layout

```
src/
  protocol.ts        canonical schema (AgentStatus / Command / Ack / envelope)
  statemachine.ts    events → working/idle/waiting (per session)
  store.ts           snapshot store + throttle + TTL prune
  binding.ts         session → inject target
  ingest.ts          local socket server (hook events in, gate decision out)
  injector/          pty (tmux/managed) · hookReturn · nativeApi · dispatch
  adapters/          claude-code · codex · cursor · gemini · openclaw · hermes · process-fallback
  runtime.ts         ACAP uplink client (reconnect/refresh/offline) + --local
  hub.ts             wires it all + local control API
  hookClient.ts      the `hook` subcommand each agent invokes
  hooks/installer.ts detect agents · wire hooks · register daemon · credentials
  acapVerify.ts      conformance check
  cli.ts             entrypoint
install.sh / install.ps1
```

## Develop & CI

```bash
npm install        # Node >= 22
npm run build      # tsc → dist/
npm test           # unit + hub integration tests (Node's built-in runner)
npm run ci         # build + verify + test (what GitHub Actions runs)
```

`.github/workflows/ci.yml` runs build + `verify` + tests on every push/PR across **macOS / Linux / Windows × Node 22 & 24**, so integration breakage is caught before merge. See `CLAUDE.md` + `ARCHITECTURE.md` to extend the codebase.

## Notes / limitations
- `pty` react-back needs the agent in a **tmux** pane (or launched under a managed pty). Without tmux, a non-tmux terminal agent returns `no inject target` — wire managed-pty (`node-pty`, an optional dep) or run agents in tmux.
- Gemini/Hermes status is process-level only until their mechanisms are confirmed; OpenClaw status is coarse (file mtime). All clearly marked in each `manifest.json`.
- Node ≥ 22 (uses the global `WebSocket`).
