# Build an ACAP adapter in an afternoon

An adapter is a **mapping, not a system**. The hard parts — transport, auth, reconnect,
fan-out, STT, the device — are already done by the Commander and the shared `AdapterRuntime`.
Your job is two functions: turn whatever your agent writes into canonical
[`status`](../schemas/status.schema.json), and turn a canonical
[`cmd`](../schemas/command.schema.json) into an action on your agent.

Read [ACAP.md](../ACAP.md) for the normative contract; this is the practical on-ramp.

---

## The shape

```
                   ┌─────────────────── AdapterRuntime (shared lib) ───────────────────┐
   your agent ───► │  connect · auth · reconnect · heartbeat · throttle · cmd dedup    │ ───► Commander
                   │                       ▲ status              ▼ cmd                  │
                   └───────────────────────┼─────────────────────┼─────────────────────┘
                                           │                     │
                              you implement │                     │ you implement
                                    Source ─┘                     └─ Sink
```

You implement two interfaces; the runtime does the rest. (Pseudocode — the SDK ships in Go for
a single static binary per machine; ports welcome.)

```go
// Source: produce canonical status. This is ALL of L0.
type Source interface {
    Install() error                  // optional: register a hook/plugin into the agent's config
    Start(emit func(Status)) error   // begin producing; call emit() with each full snapshot
    Stop() error
}

// Sink: apply a command. This is L1+. Omit for L0.
type Sink interface {
    Capabilities() []Intent          // {Prompt, Answer, Interrupt, Mode}
    Send(cmd Command) Ack            // do the thing; return delivered|rejected|nosession
}
```

The runtime handles: registration, the WS, `hello`, the send-on-change gate, the
`minStatusIntervalMs` floor, `pong`, reconnect+resync, and `cmdId` dedup. **You never write
networking.**

### Minimal L0 (the afternoon)

```go
func main() {
    rt := acap.New(acap.Config{
        APIKey:  os.Getenv("ACAP_API_KEY"),
        APIURL:  os.Getenv("ACAP_URL"),
        Kind:    "myagent",
        Level:   "L0",
        Provides: []string{"title", "model", "cwd"},
    })
    rt.Bind(&MyAgentSource{})   // implements Source
    rt.Run()                    // blocks; reconnects forever
}

type MyAgentSource struct{}
func (s *MyAgentSource) Install() error { return nil }
func (s *MyAgentSource) Stop() error    { return nil }
func (s *MyAgentSource) Start(emit func(acap.Status)) error {
    return tailMyAgentLog(func(obs Observation) {
        emit(acap.Status{
            AgentID:   fmt.Sprintf("myagent:%s:%d", hostname(), obs.PID),
            Kind:      "myagent",
            Status:    mapStatus(obs),   // idle|busy|waiting|error|ended
            Title:     obs.Title,
            Model:     obs.Model,
            Cwd:       obs.Cwd,
            PID:       obs.PID,
            UpdatedAt: nowMillis(),
        })
    })
}
```

That's a listed L0 adapter. Add `Sink` for L1, declare `capabilities`, and you're promptable.

---

## The five things every good adapter gets right

These are the load-bearing lessons from the production reference adapters. Skip them and your
adapter looks fine in a demo and breaks in real use.

### 1. Hooks first, files to enrich

For CLI agents the **lowest-latency, most-structured** status source is the agent's own
hook/plugin system (Claude Code, Codex, Cursor, Gemini, OpenCode, Hermes all ship one). The
conformant pattern:

- `Install()` writes a small hook into the agent's config (`~/.claude/settings.json` etc.) that
  **posts canonical lifecycle events to a local socket your adapter owns** (`UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `SubagentStop`).
- `Start()` listens on that socket → real-time, structured (tool name, tool input, the approval
  text).
- **Tail the transcript file only to enrich and backfill** — tokens/cost/context%, and the
  events hooks don't fire for (interrupts, compaction). Don't make file-tailing your primary
  source if a hook exists; it's laggier and lossier.

Reuse: the reference `claude-code` adapter reimplements agent-status's small jsonl parser
(`TranscriptTailer`) in Go for exactly this enrich step.

### 2. Never get stuck "busy" (liveness)

An agent **hard-killed mid-think fires no `Stop`** — so a naive adapter reports `busy` forever.
Back **every** non-terminal state with a liveness check:

```go
// the runtime calls this; you answer "is this agent still alive?"
func (s *MyAgentSource) Alive(agentID string) bool {
    return pidExists(pidOf(agentID))   // or: lockfile fresh? RPC ping ok?
}
```

When liveness fails, emit `status:"ended"`, `lastStopReason:"liveness"`. If you can't check
liveness, apply a staleness timeout and downgrade rather than report stale `busy`.

### 3. De-cumulate tokens

Some agents (Codex notably) report **cumulative** token totals on every event. If you forward
them raw they double-count and cost explodes. Diff against the previous observation into the
canonical per-session cumulative, and handle resets/restarts monotonically. (See ACAP §8.7.)

### 4. Answer approvals through the clean channel — not faked keystrokes

For `intent:"answer"`, the right mechanism is rarely a pty keystroke. With Claude Code the
`PermissionRequest` hook **blocks** on your socket — so you return the decision as the hook's
structured output and the agent unblocks. For `interrupt`, send `SIGINT` to the PID; don't fake
an `ESC`. pty/send-keys is only needed for a *fresh* prompt where no cleaner path exists.

```go
func (s *MyAgentSink) Send(cmd acap.Command) acap.Ack {
    switch cmd.Intent {
    case acap.Prompt:    return s.injectPrompt(cmd.Prompt)        // pty | API | SDK
    case acap.Answer:    return s.resolvePendingApproval(cmd.Answer) // return from blocking hook
    case acap.Interrupt: return s.signal(syscall.SIGINT)
    case acap.Mode:      return s.switchMode(cmd.Mode)
    default:             return acap.Reject("unsupported-intent")
    }
}
```

### 5. Dedupe commands (`cmdId`)

Delivery is at-least-once and your agent may have a Bash tool. The runtime dedupes by default,
but if you bypass it: track recent `cmdId`s and reply `ack:"duplicate"` for a repeat — **never
inject twice**. (ACAP §9.3, §13.)

---

## Mapping your agent — the worksheet

Fill this in and you have your adapter design:

| Canonical field | Where does my agent expose it? | Normalization needed? |
|-----------------|-------------------------------|-----------------------|
| `status` | hook event? log line? exit code? | map to `idle/busy/waiting/error/ended` |
| `waiting.{kind,text,options}` | approval prompt? | structure the free text |
| `activeTools[]` | PreToolUse / log | truncate `inputPreview` |
| `tokens` | usage event | **cumulative? → diff** |
| `context.{used,limit}` | usage / model | `[1m]` → limit 1e6 |
| `cost.usd` | priced from tokens? | per-message pricing |
| `todos[]` | TodoWrite / task events | list-replace vs incremental |
| `prompt` inject | pty? API? SDK? | the cleanest available |
| `answer` | blocking hook? approval API? | clean channel, not keystrokes |
| `interrupt` | signal? cancel RPC? | not a faked ESC |

Anything you can't source → leave out of `provides`; the Commander hides that affordance.
Anything you can → list it and populate it. That's the whole game.

---

## Test it before you ship it

```bash
acap-verify ./adapters/myagent --level L1
```

Ship `fixtures/` (recorded agent observations) so the check is offline and reproducible, then
open a registry PR (see [registry.md](../registry.md)). The harness reproduces your report in CI;
green at your claimed level = merged.

---

## Reference adapters to crib from

The deep dives in [ACAP.md §9 / design.html](../ACAP.md) walk four real shapes:

- **Claude Code** — stock interactive CLI, no native input API. Hooks + jsonl tail + PID
  liveness; `answer` via blocking hook, `interrupt` via SIGINT, `prompt` via pty/SDK. (L3)
- **Codex** — `codex_hooks` flag or log tail; cumulative-token trap; inject via
  `codex exec`/MCP/pty. Ships L0 same-day, grows to L1/L2. (L1–2)
- **openclaw** — API-native, subscribe to its event stream, inject via native API. The template
  to aim at: a few hundred lines of mapping over a stream. (L3)
- **hermes** — daemon with a local control socket; status and inject over the same RPC. (L2)

> The spread from "file-tailing CLI with no input API" to "API-native, built to be driven" is
> exactly the range ACAP absorbs. If your agent fits anywhere in that range — and it does — it
> has an adapter.

---

*ACAP 1.0 · [spec](../ACAP.md) · [conformance](../conformance.md) · [registry](../registry.md)*
