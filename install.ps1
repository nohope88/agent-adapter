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
$Rerun     = 'irm https://nohope88.github.io/agent-adapter/install.ps1 | iex'

function Say($m)  { Write-Host "▸ $m" -ForegroundColor Blue }
function Warn($m) { Write-Host "⚠ $m" -ForegroundColor Yellow }

# Print a clear, multi-line message and abort the install. We THROW rather than
# `exit`: when this script is run via `irm … | iex`, `exit` terminates the whole
# PowerShell host and slams the window shut before the user can read the error.
# A throw only stops the script — the trailing catch renders it and the window
# stays open so the message is actually visible.
function Die([string[]]$lines) {
  Write-Host ""
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -eq 0) { Write-Host "✗ $($lines[$i])" -ForegroundColor Red }
    else          { Write-Host "  $($lines[$i])" -ForegroundColor Red }
  }
  Write-Host ""
  throw 'aca-install-aborted'
}

# Abort with install guidance for a missing prerequisite. Prefers a copy-paste
# winget command when winget is available, always offers the manual download,
# and tells the user to use a FRESH terminal afterwards (so PATH picks it up).
function NeedTool($name, $wingetId, $url) {
  $lines = @("$name is required but was not found on this machine.")
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $lines += "Install it with:   winget install $wingetId"
  }
  $lines += "Or download it:    $url"
  $lines += ""
  $lines += "Then open a NEW PowerShell window (so PATH refreshes) and re-run:"
  $lines += "  $Rerun"
  Die $lines
}

try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    NeedTool 'Node.js (>= 22)' 'OpenJS.NodeJS.LTS' 'https://nodejs.org/en/download'
  }
  # Read the major from `node -v` (e.g. "v24.16.0"). We DON'T use
  # `node -p '…split(".")…'`: Windows PowerShell strips the embedded double
  # quotes when handing the arg to node, so that expression throws and the check
  # silently read 0 — wrongly demanding an upgrade even on Node 24.
  # @(…)[0] forces one line even if a shim adds output; the regex takes the
  # leading number; we fail with a clear message (not crash) if it's unreadable.
  $nodeVer = @(node -v)[0]
  if ($nodeVer -match '(\d+)') { $major = [int]$Matches[1] }
  else { Die @("Couldn't read the Node.js version (node -v returned '$nodeVer').",
               "Make sure Node.js >= 22 is installed:  https://nodejs.org/en/download") }
  if ($major -lt 22) {
    $lines = @("Node.js >= 22 is required, but this machine has $(node -v).")
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      $lines += "Update it with:    winget install OpenJS.NodeJS.LTS"
    }
    $lines += "Or download it:    https://nodejs.org/en/download"
    $lines += ""
    $lines += "Then open a NEW PowerShell window and re-run:"
    $lines += "  $Rerun"
    Die $lines
  }

  # Resolve a source checkout: run from the one we're in, else clone the repo
  # (the `irm | iex` path has no checkout on disk, so bootstrap one).
  if ($ScriptDir -and (Test-Path "$ScriptDir\package.json")) {
    $Proj = $ScriptDir
  } else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      NeedTool 'Git' 'Git.Git' 'https://git-scm.com/download/win'
    }
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
    try { npm rm -g aca | Out-Null } catch {}
    Say "Done. Remove the task with: schtasks /Delete /TN AgentAdapter /F"
    return   # `return`, not `exit` — `exit` would close the window under `irm | iex`.
  }

  Say "Installing dependencies…"
  npm install --no-audit --no-fund

  Say "Building…"
  npm run build

  # Make `aca` runnable anywhere (npm global bin is on PATH on Windows).
  Say "Linking the aca command…"
  try { npm link | Out-Null; Say "Installed: aca (npm global bin)" }
  catch { Warn "npm link failed; run directly: node `"$Proj\dist\cli.js`"" }

  Say "Detecting agents and wiring hooks…"
  node dist\cli.js setup

  Say "Done. Log in to start the adapter:"
  Say "  aca login --token <cmdr_ak_…>"
  Say "Re-sync agents anytime:  aca verify"
  Say "Optional dashboard:  aca web"
}
catch {
  # Render our own aborts cleanly (NeedTool/Die already printed the detail);
  # surface any other failure with a retry hint. Never `exit` — see Die's note.
  if ($_.Exception.Message -ne 'aca-install-aborted') {
    Write-Host ""
    Write-Host "✗ Install failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Re-run to retry:  $Rerun" -ForegroundColor Red
    Write-Host ""
  }
}
