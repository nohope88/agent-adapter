# Agent Adapter

Watch your local AI coding agents (**Claude Code · Codex · Cursor · Gemini CLI · OpenClaw · Hermes**) in real time — `working / idle / waiting` — and **react back** (answer an approval, confirm, prompt, interrupt).

It runs headless on your machine and uplinks to a **Commander**, where you see status and send commands back.

---

## How it works

```
 agents → hooks ──(local socket)──▶ ADAPTER ──(WSS)──▶ Commander
   ▲ status (working/idle/waiting)        │              (your dashboard)
   ▼ react back (answer/confirm/…)        └─ state + react-back
```

1. **Listen** — a tiny hook in each agent posts an event to a local socket on every action.
2. **Track** — events fold into one live status per session: `working`, `idle`, or `waiting` (an approval or question).
3. **React back** — a command for a waiting session is typed into the agent (answer / confirm / prompt / interrupt).
4. **Uplink** — status streams up to your Commander, and commands stream back down.

---

## Install

Needs **Node ≥ 22** and **git**.

```bash
# macOS / Linux
curl -fsSL https://nohope88.github.io/agent-adapter/install.sh | bash
```
```powershell
# Windows (PowerShell)
irm https://nohope88.github.io/agent-adapter/install.ps1 | iex
```

The script clones, builds, **detects your installed agents, wires their hooks**, and registers a background daemon (launchd / systemd / Scheduled Task). Re-run it any time to update.

Uninstall: `./install.sh --uninstall` (`.\install.ps1 --uninstall` on Windows).

---

## Use

You only need these commands:

```bash
aca login --token <cmdr_ak_…>   # connect to your Commander — the daemon starts uplinking
aca logout                      # disconnect (remove the stored credential)
aca verify                      # re-scan agents after you install or remove one
aca setup                       # re-detect agents and wire hooks (the installer runs this for you)
```

After `aca login`, everything is automatic: the daemon reports status up and applies commands coming down. **Watching status and reacting back happens in your Commander/dashboard**, not the local CLI.
