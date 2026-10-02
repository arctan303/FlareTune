#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Write-Step($msg) { Write-Host "[dev-stop] $msg" -ForegroundColor Cyan }

function Stop-PortProcess([int]$Port) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $conns) { return 0 }
  $ids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $ids) {
    $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId").CommandLine
    if (-not $commandLine -or $commandLine.IndexOf($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "Port $Port belongs to PID $procId outside this repository." }
    Write-Step "Port $Port is used by repository PID $procId, terminating process tree..."
    try {
      & node (Join-Path $RepoRoot 'tooling\dev\cleanup-processes.mjs') $procId | Out-Null
    } catch {
      Write-Warning "Failed to kill PID $procId : $_"
    }
  }
  return $ids.Count
}

Write-Step "Terminating backend (:8789) and frontend (:3000)..."
$stoppedBe = Stop-PortProcess 8789
$stoppedFe = Stop-PortProcess 3000
$total = $stoppedBe + $stoppedFe

Start-Sleep -Seconds 1

if ($total -gt 0) {
  Write-Host "[dev-stop] Successfully stopped $total service process(es)." -ForegroundColor Green
} else {
  Write-Host "[dev-stop] No services currently running on ports 8789 or 3000." -ForegroundColor Yellow
}
