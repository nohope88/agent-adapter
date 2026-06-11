# Agent Adapter installer (Windows).
#
#   irm https://<host>/install.ps1 | iex     # hosted (binary) — TODO host it
#   .\install.ps1                            # from a checkout (build from source)
#
# Steps mirror install.sh: build, detect agents, wire hooks, register a logon task.
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Action = if ($args.Count -gt 0) { $args[0] } else { 'install' }

function Say($m) { Write-Host "▸ $m" -ForegroundColor Blue }
function Die($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path "$ScriptDir\package.json")) {
  Die "Hosted binary install isn't configured yet. Clone the repo and run .\install.ps1 from it."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "node >= 22 is required (https://nodejs.org)" }
$major = [int](node -p 'process.versions.node.split(\".\")[0]')
if ($major -lt 22) { Die "node >= 22 required (found $(node -v))" }

Set-Location $ScriptDir

if ($Action -eq '--uninstall' -or $Action -eq 'uninstall') {
  Say "Removing hooks…"
  node dist\cli.js uninstall
  Say "Done. Remove the task with: schtasks /Delete /TN AgentAdapter /F"
  exit 0
}

Say "Installing dependencies…"
npm install --no-audit --no-fund

Say "Building…"
npm run build

Say "Detecting agents and wiring hooks…"
node dist\cli.js install

Say "Done. Start now with:  node `"$ScriptDir\dist\cli.js`" start --local"
Say "Check status with:     node `"$ScriptDir\dist\cli.js`" status"
