# Agent Adapter installer (Windows).
#
#   irm https://nohope88.github.io/agent-adapter/install.ps1 | iex     # hosted (self-cloning)
#   .\install.ps1                                                      # from a checkout
#
# Steps mirror install.sh: fetch/build, detect agents, wire hooks, register a logon task.
$ErrorActionPreference = 'Stop'

$RepoUrl   = if ($env:AGENT_ADAPTER_REPO) { $env:AGENT_ADAPTER_REPO } else { 'https://github.com/nohope88/agent-adapter.git' }
$SrcDir    = if ($env:AGENT_ADAPTER_SRC)  { $env:AGENT_ADAPTER_SRC }  else { Join-Path $HOME '.agent-adapter\src' }
$ScriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { '' }
$Action    = if ($args.Count -gt 0) { $args[0] } else { 'install' }

function Say($m) { Write-Host "▸ $m" -ForegroundColor Blue }
function Die($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "node >= 22 is required (https://nodejs.org)" }
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 22) { Die "node >= 22 required (found $(node -v))" }

# Resolve a source checkout: run from the one we're in, else clone the repo
# (the `irm | iex` path has no checkout on disk, so bootstrap one).
if ($ScriptDir -and (Test-Path "$ScriptDir\package.json")) {
  $Proj = $ScriptDir
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "git is required to bootstrap (https://git-scm.com)" }
  if (Test-Path "$SrcDir\.git") {
    Say "Updating $SrcDir…"
    git -C "$SrcDir" fetch --depth 1 origin main --quiet
    git -C "$SrcDir" reset --hard origin/main --quiet
  } else {
    Say "Cloning $RepoUrl → $SrcDir…"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SrcDir) | Out-Null
    git clone --depth 1 $RepoUrl $SrcDir
  }
  $Proj = $SrcDir
}

Set-Location $Proj

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

Say "Done. Log in to start the adapter:"
Say "  node `"$Proj\dist\cli.js`" login --token <cmdr_ak_…>"
Say "Then check status:   node `"$Proj\dist\cli.js`" status"
Say "Optional dashboard:  node `"$Proj\dist\cli.js`" start --web"
