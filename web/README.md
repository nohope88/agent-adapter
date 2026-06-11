# Agent Adapter — Web Dashboard (external)

A standalone live dashboard for the Agent Adapter. **It is external by design**:
it is *not* built, tested, or shipped as part of the core adapter — it's a pure
**client of the hub's existing local control API** (`/agents`, `/stream`,
`/command`). Nothing here is imported by `src/`, and the core is never modified.

```
 browser ──/──▶ web/server.js ──/api/*──▶ adapter hub (127.0.0.1:7788)
   │  (one origin: no CORS)      proxy        /agents  /stream(SSE)  /command
   └─ live cards · answer/prompt/interrupt
```

## Run

The adapter must be running first (`agent-adapter start --local`). Then:

```bash
node web/server.js
# → http://127.0.0.1:8787
```

Open the URL. Sessions appear live (SSE), sorted `waiting → working → idle →
ended`. On a **waiting** card, click an option to **answer**; on any active
card, type a **prompt** + Send, or **Interrupt**.

## Config (env)

| Var | Default | Purpose |
|---|---|---|
| `WEB_PORT` | `8787` | port the dashboard listens on |
| `WEB_HOST` | `127.0.0.1` | bind address (use `0.0.0.0` to expose on LAN — see note) |
| `AGENT_ADAPTER_CONTROL_PORT` | `7788` | the hub's control API port to proxy to |
| `AGENT_ADAPTER_CONTROL_HOST` | `127.0.0.1` | the hub's control API host |

## Notes

- **Zero dependencies, no build step.** Pure Node `http`/`fs`. Requires Node ≥ 18.
- **react-back needs an inject target.** `answer`/`prompt`/`interrupt` only land
  if the session has one (e.g. a tmux pane). Otherwise the hub replies
  `rejected: no inject target` and the dashboard shows it as a toast — expected,
  not a bug.
- **Security:** binds to `127.0.0.1` by default. The dashboard can drive agents,
  so only set `WEB_HOST=0.0.0.0` on a trusted network.
