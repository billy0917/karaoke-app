param(
  [int]$Port = 5173,
  [int]$ApiPort = 3001
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$msg) {
  Write-Host "[run-local] $msg" -ForegroundColor Cyan
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientDir = Join-Path $repoRoot 'client'
$serverDir = Join-Path $repoRoot 'server'

if (-not (Test-Path $clientDir)) {
  throw "client folder not found: $clientDir"
}

if (-not (Test-Path $serverDir)) {
  throw "server folder not found: $serverDir"
}

if (-not (Test-Path (Join-Path $serverDir 'package.json'))) {
  throw "server/package.json not found"
}

if (-not (Test-Path (Join-Path $serverDir '.env'))) {
  Write-Info 'Missing server/.env'
  if (Test-Path (Join-Path $serverDir '.env.example')) {
    Write-Info 'Create it by copying server/.env.example -> server/.env and fill in APIPLUS_API_KEY (optional for lyrics AI).'
  } else {
    Write-Info 'Create server/.env and fill in APIPLUS_API_KEY (optional for lyrics AI).'
  }
  Write-Host ''
}

Write-Info "Starting backend API on http://localhost:$ApiPort (separate window)"
Write-Info 'Close that window to stop the backend.'

# Start backend in a separate PowerShell window so it doesn't block Vite.
# Note: Vite dev proxy expects http://localhost:3001 by default.
Start-Process -FilePath 'powershell' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-Command',
  "Set-Location -Path '$serverDir'; npm install; `$env:PORT=$ApiPort; node .\\index.js"
) | Out-Null

Set-Location $clientDir

if (-not (Test-Path 'package.json')) {
  throw "client/package.json not found"
}

if (-not (Test-Path '.env.local')) {
  Write-Info 'Missing client/.env.local'
  if (Test-Path '.env.local.example') {
    Write-Info 'Create it by copying .env.local.example -> .env.local and fill in keys.'
  } else {
    Write-Info 'Create client/.env.local and fill in VITE_YT_API_KEY and VITE_FIREBASE_*.'
  }
  Write-Host ''
}

Write-Info 'Installing dependencies (npm install)'
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }

Write-Info "Starting dev server on http://localhost:$Port/"
Write-Info 'Press Ctrl+C to stop.'

# Vite will pick up .env.local automatically.
# Use --host so phones in same LAN can access (optional).
npm run dev -- --host --port $Port
