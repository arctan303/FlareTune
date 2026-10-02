#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

function Check-Service([string]$Name, [int]$Port, [string]$Url) {
  Write-Host "==========================================" -ForegroundColor DarkGray
  Write-Host "Checking $Name (Port: $Port)..." -ForegroundColor Cyan
  
  $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $conns) {
    Write-Host "  [-] Port $Port is NOT listening (Service stopped)" -ForegroundColor Red
    return
  }

  $ids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($id in $ids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "Unknown" }
    Write-Host "  [+] Listening on PID: $id ($procName)" -ForegroundColor Green
  }

  if ($Url) {
    try {
      $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      Write-Host "  [+] Health Check ($Url): HTTP $($resp.StatusCode)" -ForegroundColor Green
    } catch {
      Write-Host "  [!] Health Check ($Url) failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

Write-Host "=== Local Service Status ===" -ForegroundColor White
Check-Service -Name "Backend (Worker)" -Port 8789 -Url "http://127.0.0.1:8789/api/health"
Check-Service -Name "Frontend (Vite)" -Port 3000 -Url "http://127.0.0.1:3000"
Write-Host "==========================================" -ForegroundColor DarkGray
