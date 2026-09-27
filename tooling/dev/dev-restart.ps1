#Requires -Version 5.1
[CmdletBinding()]
param([switch]$SkipHealthCheck)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$LogDir = Join-Path $RepoRoot 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
function Write-Step($msg) { Write-Host "[dev-restart] $msg" -ForegroundColor Cyan }
function Stop-PortProcess([int]$Port) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $conns) { return 0 }
  $ids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $ids) {
    $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId").CommandLine
    if (-not $commandLine -or -not $commandLine.Contains($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Port $Port belongs to PID $procId outside this repository." }
    Write-Step "port $Port busy by repository PID $procId, stopping process tree..."
    & node (Join-Path $RepoRoot 'tooling\dev\cleanup-processes.mjs') $procId | Out-Null
  }
  return $ids.Count
}
function Wait-TcpPort([string]$Name, [int]$Port, [int]$TimeoutSec = 120) {
  Write-Step "waiting for $Name on port $Port (max ${TimeoutSec}s)"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
      if ($result.AsyncWaitHandle.WaitOne(1000) -and $client.Connected) {
        Write-Step "$Name is up on port $Port"
        return $true
      }
    } catch { }
    finally { $client.Close() }
    Start-Sleep -Seconds 1
  }
  Write-Warning "$Name did not open port $Port within ${TimeoutSec}s, check logs: $LogDir"
  return $false
}
Write-Step "=== 1/4 stop existing services ==="
$killed = Stop-PortProcess 8789
$killed += Stop-PortProcess 3000
Start-Sleep -Seconds 1
Write-Step "cleaned existing processes, starting fresh"
Write-Step "=== 2/4 start backend (wrangler dev :8789) ==="
$beLog = Join-Path $LogDir 'backend.log'
$beErr = Join-Path $LogDir 'backend.err.log'
Remove-Item $beLog, $beErr -Force -ErrorAction SilentlyContinue
$WranglerBin = Join-Path $RepoRoot 'node_modules\wrangler\bin\wrangler.js'
$be = Start-Process -FilePath 'node.exe' -ArgumentList "`"$WranglerBin`"", 'dev', '--config', 'server/wrangler.local.toml', '--port', '8789', '--ip', '127.0.0.1', '--persist-to', 'worker/.wrangler/state' -WorkingDirectory $RepoRoot -RedirectStandardOutput $beLog -RedirectStandardError $beErr -WindowStyle Hidden -PassThru
Write-Step "backend PID: $($be.Id), log: $beLog"
Write-Step "=== 3/4 start frontend (vite :3000) ==="
$feLog = Join-Path $LogDir 'frontend.log'
$feErr = Join-Path $LogDir 'frontend.err.log'
Remove-Item $feLog, $feErr -Force -ErrorAction SilentlyContinue
$fe = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' -WorkingDirectory $RepoRoot -RedirectStandardOutput $feLog -RedirectStandardError $feErr -WindowStyle Hidden -PassThru
Write-Step "frontend PID: $($fe.Id), log: $feLog"
Write-Step "=== 4/4 health check ==="
if (-not $SkipHealthCheck) {
  $beOk = Wait-TcpPort 'backend' 8789
  $feOk = Wait-TcpPort 'frontend' 3000
  Write-Step "backend: $(if ($beOk) { 'OK' } else { 'FAILED' })  frontend: $(if ($feOk) { 'OK' } else { 'FAILED' })"
} else {
  Start-Sleep -Seconds 5
}
Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  frontend: http://localhost:3000" -ForegroundColor Green
Write-Host "  backend:  http://localhost:8789" -ForegroundColor Green
Write-Host "  logs:     $LogDir" -ForegroundColor Green
Write-Host "======================================================" -ForegroundColor Green
