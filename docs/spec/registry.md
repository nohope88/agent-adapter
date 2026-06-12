# ACAP Adapter Registry & Governance

The registry is how a new agent becomes officially listed: an open folder of adapter manifests.
Passing [`acap-verify`](./conformance.md) plus one PR = listed. This document defines the
manifest format and the (intentionally light) governance around it.

The point of the registry is discovery and trust signaling, **not** gatekeeping the protocol.
ACAP is open: anyone may run their own adapter against any Commander without ever appearing
here. The registry just answers "which adapters exist, at what level, maintained by whom."

---

## 1. Layout

```
registry/
  claude-code/
    adapter.json          # the manifest (required)
    acap-verify.json      # latest passing harness report (required)
    README.md             # human docs, install, caveats (recommended)
    icon.svg              # optional
  codex/
    adapter.json
    acap-verify.json
  openclaw/
    …
```

One directory per `kind`. The directory name **MUST** equal the manifest `kind` and be a unique
lowercase-kebab slug across the registry. A `kind` is claimed by the first merged adapter; a
second implementation of the same agent uses a distinct slug (e.g. `codex-mcp`) or contributes
to the existing one.

---

## 2. Manifest — `adapter.json`

```json
{
  "v": 1,
  "kind": "codex",
  "displayName": "Codex",
  "description": "OpenAI Codex CLI — status via codex_hooks/log, inject via codex exec / MCP / pty.",
  "acap": "1.0",
  "level": "L1",
  "capabilities": ["prompt"],
  "provides": ["status", "activeTool", "model", "tokens", "cost"],
  "statusSource": ["hook", "log-tail"],
  "injectVia": ["codex-exec", "mcp", "pty"],
  "platforms": ["macos", "linux", "windows"],
  "repo": "https://github.com/acme/acap-codex-adapter",
  "license": "MIT",
  "maintainers": [
    { "name": "Jane Dev", "github": "janedev", "contact": "jane@example.com" }
  ],
  "verifiedWith": "acap-verify/1.0.3",
  "icon": "icon.svg"
}
```

| Field | Required | Rule |
|-------|----------|------|
| `v` | ✓ | Manifest version, `1`. |
| `kind` | ✓ | Unique slug; equals directory name. |
| `displayName` | ✓ | Shown in the dashboard. |
| `description` | ✓ | One line. |
| `acap` | ✓ | ACAP version implemented. |
| `level` | ✓ | **MUST** equal the `certifiedLevel` in the accompanying `acap-verify.json`. |
| `capabilities` | ✓ | **MUST** equal what the harness certified. |
| `provides` | ✓ | Status field keys populated. |
| `statusSource` | ✓ | How status is read: any of `hook`, `log-tail`, `file-tail`, `native-stream`, `rpc`, `sdk`. Informational. |
| `injectVia` | ✓ if `level≠L0` | Mechanisms used for commands. Informational. |
| `platforms` | ✓ | Subset of `macos`, `linux`, `windows`. |
| `repo` | ✓ | Source URL. The adapter need not live in this repo; the manifest references it. |
| `license` | ✓ | SPDX id. **MUST** be an OSI-approved license for a listed adapter. |
| `maintainers` | ✓ | ≥ 1, with a reachable contact (for security disclosure). |
| `verifiedWith` | ✓ | `acap-verify` version that produced the report. |
| `icon` | — | Relative path in the dir. |

`adapter.json` **MUST** validate against
[`schemas/manifest.schema.json`](./schemas/manifest.schema.json) and be internally consistent
with its `acap-verify.json`.

---

## 3. Adding or updating an adapter — one PR

1. Implement against [ACAP.md](./ACAP.md). Ship `fixtures/` for offline conformance.
2. Run `acap-verify ./your-adapter --level <L>`; get a green `acap-verify.json`.
3. Open a PR adding `registry/<kind>/` with `adapter.json` + `acap-verify.json` (+ README/icon).
4. **CI re-runs `acap-verify` against your committed fixtures** — the report must reproduce; a
   manifest that claims a level its fixtures don't earn fails CI. This is the only hard gate.
5. A maintainer merges. Listing is now live; the Commander dashboard can surface it.

Updating (new level, new ACAP version, new maintainer) is the same flow against the existing
directory. **Bumping a level requires a fresh passing report** for that level.

### Governance principles

- **Mechanical, not editorial.** Merge criteria are: schema-valid manifest, OSI license,
  reachable maintainer, and a CI-reproduced green report at the claimed level. Reviewers do
  **not** judge whether an agent is "worthy."
- **Additive and versioned.** New `kind`s, capabilities, and ACAP minor versions are additive.
  Old listings stay valid until their `acap` major version is retired.
- **Trust signal, not lock-in.** Unlisted adapters work identically on the wire. The registry
  confers discoverability and a verified badge, nothing more.

---

## 4. Deprecation, security, and removal

- **Security contact.** `maintainers[].contact` is the disclosure channel. A vulnerability in a
  listed adapter is reported there; the registry adds a `SECURITY.md` with the coordinated
  process.
- **Staleness.** A listing whose adapter no longer passes the current `acap-verify` major
  version is flagged `outdated` (not removed) until updated.
- **Removal.** A maintainer may remove their own listing by PR. The project removes a listing
  only for license violation, an unaddressed security issue, or squatting an unused `kind`.
- **`kind` reclamation.** An abandoned `kind` (maintainer unreachable > 90 days, failing CI) may
  be reassigned after a public notice period.

---

## 5. Built-in vs. community adapters

The reference Commander ships first-party adapters for the agents in
[ACAP.md §9 deep dives](./ACAP.md) (`claude-code`, `codex`, `openclaw`, `hermes`). They live in
the same registry under the same rules and earn their levels through the same harness — there is
no privileged path. "First-party" means only "maintained by the core team," carrying no protocol
privilege over a community adapter at the same level.

---

*ACAP 1.0 · [spec](./ACAP.md) · [conformance](./conformance.md) · [adapter skeleton](./adapters/SKELETON.md)*
