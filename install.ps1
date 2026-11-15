# OpenClicky installer — Windows (PowerShell 5.1+ or 7+).
#
#   irm https://raw.githubusercontent.com/ranaalyan1/openclicky/main/install.ps1 | iex
#
# What it does, in order:
#   1. checks Node 18+ (points you at nodejs.org if missing)
#   2. downloads OpenClicky to %USERPROFILE%\.openclicky (or updates it)
#   3. installs every dependency automatically
#   4. compiles the workspace
#   5. asks for the two keys and verifies them live
#        KEY 1 · model   — any OpenAI-compatible key   (required)
#        KEY 2 · search  — Brave Search, free tier     (optional)
#   6. tells you how to start it
#
# Flags:  -Start   launch the panel when setup finishes
#         -Dir DIR install somewhere else
#         -Yes     skip the key prompts (add keys later with npm run setup)

[CmdletBinding()]
param(
  [switch]$Start,
  [string]$Dir = (Join-Path $env:USERPROFILE '.openclicky'),
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$repoZip = 'https://codeload.github.com/ranaalyan1/openclicky/zip/refs/heads/main'

function Write-Ok($m) { Write-Host "OK  $m" -ForegroundColor Green }
function Write-Dim($m) { Write-Host $m -ForegroundColor DarkGray }
function Die($m, $hint) {
  Write-Host "ERROR  $m" -ForegroundColor Red
  if ($hint) { Write-Dim $hint }
  exit 1
}

# ---------- 1. node ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die 'Node.js is not installed.' 'Install Node 20 LTS from https://nodejs.org (winget install OpenJS.NodeJS.LTS) then re-run.'
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) {
  Die "Node $(node -v) is too old - OpenClicky needs 18+." 'Get Node 20 LTS from https://nodejs.org and re-run.'
}
Write-Ok "node $(node -v)"
Write-Ok "npm $(npm -v)"

# ---------- 2. fetch the source ----------
if (Test-Path (Join-Path $Dir 'package.json')) {
  Write-Dim "using existing checkout at $Dir"
} else {
  Write-Dim "downloading OpenClicky into $Dir"
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $zip = Join-Path $env:TEMP 'openclicky.zip'
  try {
    Invoke-WebRequest -Uri $repoZip -OutFile $zip -UseBasicParsing
  } catch {
    Die 'download failed' "Check your connection, or download $repoZip manually and extract it to $Dir"
  }
  $tmp = Join-Path $env:TEMP ('openclicky-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Dir -Recurse -Force
  Remove-Item $tmp, $zip -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Ok "source at $Dir"

Set-Location $Dir

# ---------- 3 + 4 + 5. deps, build, the two keys ----------
Write-Host ''
Write-Host 'Installing dependencies - this is the only slow step.' -ForegroundColor White
if ($Yes) { $env:OPENCLICKY_SKIP_SETUP = '1' }
node scripts/setup.mjs
if ($LASTEXITCODE -ne 0) { Die 'setup failed' 'Re-run: node scripts/setup.mjs' }

# ---------- 6. how to run ----------
Write-Host ''
Write-Host 'OpenClicky is installed.' -ForegroundColor White
Write-Host "  panel     cd `"$Dir`"; npm start      -> http://127.0.0.1:4747"
Write-Host "  terminal  cd `"$Dir`"; npm run chat"
Write-Host "  re-key    cd `"$Dir`"; npm run setup"
Write-Host "  overlay   cd `"$Dir`"; npm run overlay  (frameless always-on-top window)"
Write-Host ''

if ($Start) {
  Write-Dim 'starting the panel (Ctrl+C to stop)'
  npm start
}
