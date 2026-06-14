# Adapter verification — 2026-06-14

Verified all six adapters against the live setup on this machine:

- **Local hub** — `aca start` (launchd `com.agent-adapter`), control API `127.0.0.1:7788`.
- **Dashboard** — `aca web` on `127.0.0.1:8787`, Local tab (→ hub) and Cloud tab (→ Commander `commander-api.autonomous.ai`, logged in as `tamnguyenfe@gmail.com`).

## Bug found & fixed: level ↔ capability inconsistency

The adapter descriptors declared capabilities that contradicted their ACAP level
(spec §11). The live Commander enforces this on `register` and was rejecting two
adapters:

```
[uplink] register gemini failed: 400 invalid_register "L0 must declare no capabilities"
[uplink] register hermes failed: 400 invalid_register "L0 must declare no capabilities"
```

A failed `:adapter` register means the whole kind connection never opens, so
**gemini and hermes sessions could never reach the Cloud at all.**

| Adapter | Level | Declared (before) | Spec §11 requires | Fixed to |
|---|---|---|---|---|
| gemini  | L0 | `["prompt"]` | `[]` | `[]` |
| hermes  | L0 | `["prompt","answer","interrupt"]` | `[]` | `[]` |
| openclaw | L1 | `["prompt","answer","interrupt"]` | `["prompt"]` | `["prompt"]` |

claude-code (L3), codex (L2), cursor (L2) were already consistent.

`src/acapVerify.ts` only checked *lower* bounds (L1+ needs `prompt`, L2+ needs
`answer`/`interrupt`). It now also enforces the *upper* bounds the Commander
applies — `L0 → []`, `L1 → exactly ["prompt"]` — so `selfcheck` catches this
class of bug before it ships. Two regression tests added.

## Verification result (after fix)

Hub restarted with the rebuilt `dist/`. All five **detected** adapters register
and open their WS — log shows `uplink ready` for each:

```
uplink ready: claude-code   uplink ready: codex     uplink ready: cursor
uplink ready: gemini        uplink ready: hermes
```

(openclaw is not installed on this machine — `~/.openclaw` absent — so it never
connects; its descriptor is now spec-correct for when it is.)

Per-kind status flow Local → Cloud, verified by injecting one representative
session per kind that has no live agent and comparing both rosters:

| Kind | Injected | Local status | Cloud status | Match |
|---|---|---|---|---|
| claude-code | live session (this terminal) | busy / waiting | busy / waiting | ✓ |
| codex  | PermissionRequest | `waiting` (approval, text+options, model) | `waiting` (approval, text+options) | ✓ |
| cursor | PermissionRequest | `waiting` (approval, text+options) | `waiting` (approval, text+options) | ✓ |
| gemini | UserPromptSubmit | `busy` (title, cwd) | `busy` (title, cwd) | ✓ |
| hermes | UserPromptSubmit | `busy` (title, cwd) | `busy` (title, cwd) | ✓ |

All injected sessions were ended and cleaned up afterward. Status, waiting
`kind`/`text`/`options`, title, cwd, and activeTools agree between Local and
Cloud for every rendered field.

## Local vs Cloud differences

No backend (Commander) discrepancy requiring action. Two minor, non-actionable notes:

1. **Commander omits `waiting.options` when empty.** Local sends `options: []`;
   the Commander stores `waiting` without the key. Cosmetic and arguably correct
   (empty array elided). No UI impact.
2. **Dashboard Cloud bridge under-maps non-displayed fields.** `web/server.js`
   `mapAgent()` does not carry `model`/`mode`/`branch`/`context`/`cost` from the
   Commander record into the Cloud roster. The Commander **does** store them
   correctly (confirmed in the raw record). The dashboard card UI (`app.js`)
   does not render those fields, so there is **no visible Local↔Cloud
   difference**. Left as-is — the web dashboard is out of scope for the adapter
   (CLAUDE.md), and the omission has no display effect.

## Coverage note (not a bug)

Live process-detection for codex (rollout poll), gemini/hermes (process
baseline), and openclaw (session-file poll) is exercised by the unit suite
(100% line coverage), not by a live agent here — verifying those end-to-end
needs each agent actually running interactively. The state→wire→Commander path
for every kind was verified live via injection (table above).
