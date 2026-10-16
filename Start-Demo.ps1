<#
.SYNOPSIS
  Start the UpwardScoreboard laptop demo: Docker stack, demo data, two browser windows side by side.
.PARAMETER Reseed
  Wipe all teams, courts and games and load fresh demo data for today.
.PARAMETER NoBrowser
  Do not open browser windows.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1
  powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1 -Reseed
#>
[CmdletBinding()]
param(
  [switch]$Reseed,
  [switch]$NoBrowser
)

# 'Continue': in Windows PowerShell 5.1, 'Stop' turns native stderr output (docker progress) into errors.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$Base = 'http://localhost:3000'
$ScoreUrl = "$Base/score/west"
$TvUrl = "$Base/upwardbasketballscores/westcourt"

function Fail([string]$Message) {
  Write-Host ''
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

# 1. Docker running?
Write-Host 'Checking Docker...' -ForegroundColor Cyan
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker was not found. Install Docker Desktop and open it once.' }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker is not running. Start Docker Desktop, wait until it says "Engine running", then run this script again.' }

# 2. Build and start
Write-Host 'Starting the app (first run builds the image, a few minutes)...' -ForegroundColor Cyan
& docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed. Is port 3000 already in use? See DEMO.md, Troubleshooting.' }

# 3. Wait for health
Write-Host 'Waiting for http://localhost:3000 ...' -ForegroundColor Cyan
$healthy = $false
for ($i = 0; $i -lt 90; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "$Base/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $healthy) { Fail 'The app did not become healthy in 3 minutes. Run: docker compose logs app' }

# 4. Demo data: seed when nothing is scheduled for today, or always with -Reseed
if ($Reseed) { $seedArgs = @('--reset') } else { $seedArgs = @() }
$out = & docker compose exec -T app node dist/src/seed-demo.js @seedArgs 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Write-Host $out; Fail 'Demo seed failed.' }
Write-Host $out.Trim()
if ($out -match 'SEEDED') {
  # Restart so the server and any open screens pick up the fresh data.
  & docker compose restart app *> $null
  for ($i = 0; $i -lt 60; $i++) {
    try { $r = Invoke-WebRequest -Uri "$Base/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop; if ($r.StatusCode -eq 200) { break } } catch { }
    Start-Sleep -Seconds 1
  }
}

Write-Host ''
Write-Host "Scorekeeper (left): $ScoreUrl   PIN 2222" -ForegroundColor Green
Write-Host "TV (right):         $TvUrl" -ForegroundColor Green
Write-Host "Admin:              $Base/admin   password change-me-admin" -ForegroundColor Green

# 5. Browser windows side by side
if ($NoBrowser) { exit 0 }
$w = 1280; $h = 800
try {
  Add-Type -AssemblyName System.Windows.Forms
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $w = [int]($area.Width / 2); $h = [int]$area.Height
} catch { }

$edge = $null
foreach ($p in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")) {
  if ($p -and (Test-Path $p)) { $edge = $p; break }
}
if ($edge) {
  # Separate profile folder so the window flags apply even when Edge is already open.
  $profileDir = Join-Path $env:TEMP 'UpwardScoreboardDemo'
  Start-Process -FilePath $edge -ArgumentList @("--user-data-dir=`"$profileDir`"", '--no-first-run', '--new-window', '--window-position=0,0', "--window-size=$w,$h", $ScoreUrl)
  Start-Sleep -Seconds 2
  Start-Process -FilePath $edge -ArgumentList @("--user-data-dir=`"$profileDir`"", '--new-window', "--window-position=$w,0", "--window-size=$w,$h", $TvUrl)
} else {
  Write-Host 'Edge not found; opening the default browser. Arrange the windows: scorekeeper left, TV right (Win+Left / Win+Right).' -ForegroundColor Yellow
  Start-Process $ScoreUrl
  Start-Sleep -Seconds 1
  Start-Process $TvUrl
}
