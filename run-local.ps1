param(
  [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$msg) {
  Write-Host "[run-local] $msg" -ForegroundColor Cyan
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$clientDir = Join-Path $repoRoot 'client'

if (-not (Test-Path $clientDir)) {
  throw "client folder not found: $clientDir"
}

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
