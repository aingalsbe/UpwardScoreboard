<#
.SYNOPSIS
  Start the UpwardScoreboard laptop demo: Docker stack, demo data, two browser windows side by side
  (three with -Schedule: the lobby TV).
.PARAMETER Reseed
  Wipe all teams, courts and games and load fresh demo data for the demo weekend (this Fri/Sat, or the upcoming one).
.PARAMETER Schedule
  Also open the lobby TV (/upwardbasketballscores/lobby, live + next per court) as a third window (scorekeeper | TV | lobby, a third of the screen each).
.PARAMETER NoBrowser
  Do not open browser windows.
.PARAMETER WindowsOnly
  Only (re)open the two demo windows; assumes the app is already running.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1
  powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1 -Reseed
  powershell -ExecutionPolicy Bypass -File .\Start-Demo.ps1 -Schedule
#>
[CmdletBinding()]
param(
  [switch]$Reseed,
  [switch]$NoBrowser,
  [switch]$WindowsOnly,
  [switch]$Schedule
)

# 'Continue': in Windows PowerShell 5.1, 'Stop' turns native stderr output (docker progress) into errors.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$Base = 'http://localhost:3000'
# Demo weekend: Saturday has the West/East block (scorekeeper on West, PIN 2222); any other day the next games
# are the Full Court games (Friday evening), so the demo uses Full (PIN 1111). The lobby shows Fri or Sat.
$IsSat = (Get-Date).DayOfWeek -eq 'Saturday'
if ($IsSat) { $Court = 'west'; $Pin = '2222'; $Day = 'sat' } else { $Court = 'full'; $Pin = '1111'; $Day = 'fri' }
$ScoreUrl = "$Base/score/$Court"
$TvUrl = "$Base/upwardbasketballscores/${Court}court"
$ScheduleUrl = "$Base/upwardbasketballscores/lobby?day=$Day"

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
Write-Host "Scorekeeper (left): $ScoreUrl   PIN $Pin" -ForegroundColor Green
Write-Host "TV (right):         $TvUrl" -ForegroundColor Green
Write-Host "Lobby TV:           $ScheduleUrl   (also ?day=fri / ?day=sat / ?date=YYYY-MM-DD)" -ForegroundColor Green
Write-Host "Admin:              $Base/admin   password change-me-admin" -ForegroundColor Green

# 5. Browser windows side by side: two Edge app windows, each with its own throwaway profile so
#    --window-position / --window-size are honored even when Aaron's normal Edge is open.
if ($NoBrowser) { exit 0 }
$x0 = 0; $y0 = 0; $w = 960; $h = 1040
try {
  Add-Type -Namespace UsbDemo -Name Win -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
"@ -ErrorAction Stop
  [void][UsbDemo.Win]::SetProcessDPIAware()  # physical pixels for both the screen size and MoveWindow (display scaling)
} catch { }
try {
  Add-Type -AssemblyName System.Windows.Forms
  $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $cols = 2; if ($Schedule) { $cols = 3 }
  $x0 = $area.X; $y0 = $area.Y; $w = [int][Math]::Floor($area.Width / $cols); $h = [int]$area.Height
} catch { }

$profileRoot = Join-Path $env:LOCALAPPDATA 'UpwardScoreboardDemo'

# Close earlier demo windows only (identified by the demo profile folder); other Edge windows are untouched.
try {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileRoot) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
} catch { }
# Fresh throwaway profiles every run (never signed in, no leftover state).
Remove-Item -Path $profileRoot -Recurse -Force -ErrorAction SilentlyContinue

$edge = $null
foreach ($p in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")) {
  if ($p -and (Test-Path $p)) { $edge = $p; break }
}
if (-not $edge) {
  Write-Host 'Edge not found; opening the default browser. Arrange the windows: scorekeeper left, TV right (Win+Left / Win+Right).' -ForegroundColor Yellow
  Start-Process $ScoreUrl
  Start-Sleep -Seconds 1
  Start-Process $TvUrl
  if ($Schedule) { Start-Sleep -Seconds 1; Start-Process $ScheduleUrl }
  exit 0
}

function Open-DemoWindow([string]$Name, [string]$Url, [int]$X) {
  $dir = Join-Path $profileRoot $Name
  # --disable-features=msImplicitSignin / --disable-sync: keep the throwaway profile signed out (no sync pop-up).
  $argList = @("--user-data-dir=`"$dir`"", '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-features=msImplicitSignin,msEdgeSyncConsent', "--app=$Url", "--window-position=$X,$y0", "--window-size=$w,$h")
  Start-Process -FilePath $edge -ArgumentList $argList | Out-Null
}

# Fallback positioning: find each demo window by its title and move it (the flags can be off with display scaling).
function Set-DemoWindow([string]$TitleLike, [int]$X) {
  for ($i = 0; $i -lt 60; $i++) {
    $gp = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like $TitleLike } | Select-Object -First 1
    if ($gp) {
      try { [void][UsbDemo.Win]::ShowWindow($gp.MainWindowHandle, 9); [void][UsbDemo.Win]::MoveWindow($gp.MainWindowHandle, $X, $y0, $w, $h, $true) } catch { }
      return $true
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

Open-DemoWindow 'score' $ScoreUrl $x0
Open-DemoWindow 'tv' $TvUrl ($x0 + $w)
Start-Sleep -Seconds 2
$null = Set-DemoWindow 'UpwardScoreboard*Scorekeeper*' $x0
$null = Set-DemoWindow 'UpwardScoreboard*TV*' ($x0 + $w)
if ($Schedule) {
  Open-DemoWindow 'schedule' $ScheduleUrl ($x0 + 2 * $w)
  Start-Sleep -Seconds 2
  $null = Set-DemoWindow 'UpwardScoreboard*Lobby*' ($x0 + 2 * $w)
  Write-Host "Opened scorekeeper, TV and lobby, each ${w}x${h}." -ForegroundColor Green
} else { Write-Host "Opened scorekeeper (left) and TV (right), each ${w}x${h}." -ForegroundColor Green }
