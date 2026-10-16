<#
.SYNOPSIS
  Start the UpwardScoreboard laptop demo: Docker stack, demo data, two browser windows side by side.
.PARAMETER Reseed
  Wipe all teams, courts and games and load fresh demo data for today.
.PARAMETER NoBrowser
  Do not open browser windows.
.PARAMETER WindowsOnly
  Only (re)open the two demo windows; assumes the app is already running.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1
  powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1 -Reseed
#>
[CmdletBinding()]
param(
  [switch]$Reseed,
  [switch]$NoBrowser,
  [switch]$WindowsOnly
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

if (-not $WindowsOnly) {
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

}

Write-Host ''
Write-Host "Scorekeeper (left): $ScoreUrl   PIN 2222" -ForegroundColor Green
Write-Host "TV (right):         $TvUrl" -ForegroundColor Green
Write-Host "Admin:              $Base/admin   password change-me-admin" -ForegroundColor Green

# 5. Browser windows side by side: two Edge app windows, each with its own throwaway profile so
#    --window-position / --window-size are honored even when Aaron's normal Edge is open.
if ($NoBrowser) { exit 0 }
$x0 = 0; $y0 = 0; $w = 960; $h = 1040
try {
  Add-Type -AssemblyName System.Windows.Forms
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x0 = $area.X; $y0 = $area.Y; $w = [int][Math]::Floor($area.Width / 2); $h = [int]$area.Height
} catch { }

$profileRoot = Join-Path $env:LOCALAPPDATA 'UpwardScoreboardDemo'

# Close earlier demo windows only (identified by the demo profile folder); other Edge windows are untouched.
try {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
} catch { }

$edge = $null
foreach ($p in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")) {
  if ($p -and (Test-Path $p)) { $edge = $p; break }
}
if (-not $edge) {
  Write-Host 'Edge not found; opening the default browser. Arrange the windows: scorekeeper left, TV right (Win+Left / Win+Right).' -ForegroundColor Yellow
  Start-Process $ScoreUrl
  Start-Sleep -Seconds 1
  Start-Process $TvUrl
  exit 0
}

try {
  Add-Type -Namespace UsbDemo -Name Win -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
"@ -ErrorAction Stop
} catch { }

function Open-DemoWindow([string]$Name, [string]$Url, [int]$X) {
  $dir = Join-Path $profileRoot $Name
  $argList = @("--user-data-dir=`"$dir`"", '--no-first-run', '--no-default-browser-check', "--app=$Url",
    "--window-position=$X,$y0", "--window-size=$w,$h")
  Start-Process -FilePath $edge -ArgumentList $argList | Out-Null
  # Fallback: move the window explicitly once it exists (DPI scaling can shift the flags).
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) }
    foreach ($cp in $procs) {
      $gp = Get-Process -Id $cp.ProcessId -ErrorAction SilentlyContinue
      if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
        try { [void][UsbDemo.Win]::ShowWindow($gp.MainWindowHandle, 9); [void][UsbDemo.Win]::MoveWindow($gp.MainWindowHandle, $X, $y0, $w, $h, $true) } catch { }
        return
      }
    }
  }
}

Open-DemoWindow 'score' $ScoreUrl $x0
Open-DemoWindow 'tv' $TvUrl ($x0 + $w)
Write-Host "Opened scorekeeper (left) and TV (right), each ${w}x${h}." -ForegroundColor Green
