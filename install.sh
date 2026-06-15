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
RERUN="curl -fsSL https://nohope88.github.io/agent-adapter/install.sh | bash"

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
# Print a headline (first arg) plus any number of indented detail lines, then
# abort. (Run via `curl … | bash` this ends the child shell, not your terminal.)
die() {
  printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2
  shift
  for line in "$@"; do printf '\033[31m  %s\033[0m\n' "$line" >&2; done
  printf '\n' >&2
  exit 1
}

# Suggest a one-line install command for $1 (node|git) using whatever package
# manager is present; prints nothing if none is recognised.
pkg_hint() {
  case "$1" in
    git)
      if   command -v brew    >/dev/null 2>&1; then echo "brew install git"
      elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y git"
      elif command -v dnf     >/dev/null 2>&1; then echo "sudo dnf install -y git"
      elif command -v pacman  >/dev/null 2>&1; then echo "sudo pacman -S --noconfirm git"
      fi ;;
    node)
      # Distro node packages are often < 22, so prefer brew / the official build.
      if command -v brew >/dev/null 2>&1; then echo "brew install node"; fi ;;
  esac
}

# Abort with install guidance for a missing prerequisite.
# need_tool <name> <download-url> [install-hint]
need_tool() {
  if [ -n "${3:-}" ]; then
    die "$1 is required but was not found on this machine." \
        "Install it with:  $3" \
        "Or download it:   $2" \
        "" "Then re-run:" "  $RERUN"
  else
    die "$1 is required but was not found on this machine." \
        "Download it:  $2" \
        "" "Then re-run:" "  $RERUN"
  fi
}

command -v node >/dev/null 2>&1 || need_tool "Node.js (>= 22)" "https://nodejs.org/en/download" "$(pkg_hint node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  hint="$(pkg_hint node)"
  if [ -n "$hint" ]; then
    die "Node.js >= 22 is required, but this machine has $(node -v)." \
        "Update it with:  $hint" \
        "Or download it:  https://nodejs.org/en/download" \
        "" "Then re-run:" "  $RERUN"
  else
    die "Node.js >= 22 is required, but this machine has $(node -v)." \
        "Download it:  https://nodejs.org/en/download" \
        "" "Then re-run:" "  $RERUN"
  fi
fi

# Resolve a source checkout: run from the one we're in, else clone the repo
# (the `curl | bash` path has no checkout on disk, so bootstrap one).
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  PROJ="$SCRIPT_DIR"
else
  command -v git >/dev/null 2>&1 || need_tool "Git" "https://git-scm.com/downloads" "$(pkg_hint git)"
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
  rm -f "$HOME/.local/bin/aca" "/usr/local/bin/aca" 2>/dev/null || true
  say "Done. (Stop the daemon: launchctl unload ~/Library/LaunchAgents/com.agent-adapter.plist  or  systemctl --user disable --now agent-adapter)"
  exit 0
fi

say "Installing dependencies…"
npm install --no-audit --no-fund

say "Building…"
npm run build

# Make `aca` runnable anywhere: symlink the CLI into a bin dir on PATH.
say "Linking the aca command…"
chmod +x "$PROJ/dist/cli.js" 2>/dev/null || true
BIN_DIR=""
for d in "$HOME/.local/bin" "/usr/local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then BIN_DIR="$d"; break; fi
done
[ -z "$BIN_DIR" ] && mkdir -p "$HOME/.local/bin" 2>/dev/null && BIN_DIR="$HOME/.local/bin"
if [ -n "$BIN_DIR" ] && ln -sf "$PROJ/dist/cli.js" "$BIN_DIR/aca" 2>/dev/null; then
  say "Installed: $BIN_DIR/aca"
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "⚠ $BIN_DIR is not on PATH — add:  export PATH=\"$BIN_DIR:\$PATH\"";; esac
else
  say "⚠ couldn't link globally; run directly:  node \"$PROJ/dist/cli.js\""
fi

say "Detecting agents and wiring hooks…"
node dist/cli.js setup   # wires hooks + registers the headless daemon

# The daemon runs the headless adapter; `start` waits for a credential, so the
# adapter goes live once you log in. The web dashboard is opt-in, not installed.
say "Done. Log in to start the adapter:"
say "  aca login --token <cmdr_ak_…>"
say "Re-sync agents anytime:  aca verify"
say "Optional dashboard:  aca web"
