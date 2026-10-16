<#
.SYNOPSIS
  Stop the UpwardScoreboard demo.
.PARAMETER Wipe
  Also delete the database volume (all teams, games and uploads). Next start seeds fresh demo data.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1
  powershell -ExecutionPolicy Bypass -File .\Stop-Demo.ps1 -Wipe
#>
[CmdletBinding()]
param([switch]$Wipe)

# 'Continue': in Windows PowerShell 5.1, 'Stop' turns native stderr output (docker progress) into errors.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
& docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker is not running; nothing to stop.' -ForegroundColor Yellow; exit 0 }
if ($Wipe) {
  Write-Host 'Stopping and deleting demo data...' -ForegroundColor Cyan
  & docker compose down -v
} else {
  Write-Host 'Stopping (data is kept)...' -ForegroundColor Cyan
  & docker compose down
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Stopped.' -ForegroundColor Green
