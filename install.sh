#!/usr/bin/env bash
# Agent Adapter installer (macOS / Linux).
#
#   curl -fsSL https://<host>/install.sh | bash      # hosted (binary) — TODO host it
#   ./install.sh                                     # from a checkout (build from source)
#
# Steps: build (or fetch) the adapter, detect installed agents, wire their
# hooks, register the background daemon. Re-runnable; `./install.sh --uninstall`
# removes the hooks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ACTION="${1:-install}"

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  die "Hosted binary install isn't configured yet. Clone the repo and run ./install.sh from it."
fi

command -v node >/dev/null 2>&1 || die "node >= 22 is required (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required (found $(node -v))"

cd "$SCRIPT_DIR"

if [ "$ACTION" = "--uninstall" ] || [ "$ACTION" = "uninstall" ]; then
  say "Removing hooks…"
  node dist/cli.js uninstall || node_modules/.bin/tsx src/cli.ts uninstall 2>/dev/null || true
  say "Done. (Stop the daemon: launchctl unload ~/Library/LaunchAgents/com.agent-adapter.plist  or  systemctl --user disable --now agent-adapter)"
  exit 0
fi

say "Installing dependencies…"
npm install --no-audit --no-fund

say "Building…"
npm run build

say "Detecting agents and wiring hooks…"
node dist/cli.js install

say "Done. Start now with:  node \"$SCRIPT_DIR/dist/cli.js\" start --local"
say "Check status with:     node \"$SCRIPT_DIR/dist/cli.js\" status"
