#!/usr/bin/env bash
# Agent Adapter installer (macOS / Linux).
#
#   curl -fsSL https://nohope88.github.io/agent-adapter/install.sh | bash   # hosted (self-cloning)
#   ./install.sh                                                            # from a checkout
#
# Steps: fetch/build the adapter, detect installed agents, wire their hooks,
# register the background daemon. Re-runnable; `--uninstall` removes the hooks.
set -euo pipefail

REPO_URL="${AGENT_ADAPTER_REPO:-https://github.com/nohope88/agent-adapter.git}"
SRC_DIR="${AGENT_ADAPTER_SRC:-$HOME/.agent-adapter/src}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
ACTION="${1:-install}"

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node >= 22 is required (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required (found $(node -v))"

# Resolve a source checkout: run from the one we're in, else clone the repo
# (the `curl | bash` path has no checkout on disk, so bootstrap one).
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  PROJ="$SCRIPT_DIR"
else
  command -v git >/dev/null 2>&1 || die "git is required to bootstrap (https://git-scm.com)"
  if [ -d "$SRC_DIR/.git" ]; then
    say "Updating ${SRC_DIR}…"
    git -C "$SRC_DIR" fetch --depth 1 origin main --quiet
    git -C "$SRC_DIR" reset --hard origin/main --quiet
  else
    say "Cloning $REPO_URL → ${SRC_DIR}…"
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --depth 1 "$REPO_URL" "$SRC_DIR"
  fi
  PROJ="$SRC_DIR"
fi

cd "$PROJ"

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
node dist/cli.js install   # wires hooks + registers the headless daemon

# The daemon runs the headless adapter; `start` waits for a credential, so the
# adapter goes live once you log in. The web dashboard is opt-in, not installed.
CLI="node \"$PROJ/dist/cli.js\""
say "Done. Log in to start the adapter:"
say "  $CLI login --token <cmdr_ak_…>"
say "Then check status:  $CLI status"
say "Optional dashboard:  $CLI start --web"
