[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "Torsionfield\cua-mcp"
$receiptPath = Join-Path $runtimeRoot "connection.json"

if (-not (Test-Path $receiptPath)) {
  Write-Host "No active Torsionfield CUA MCP receipt exists at $receiptPath"
  exit 0
}

$receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
foreach ($property in @("tunnelPid", "gatewayPid", "cuaDaemonPid")) {
  $pidValue = $receipt.$property
  if ($pidValue) {
    $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      Write-Host "Stopped $property process $($process.Id)"
    }
  }
}

$cua = $receipt.cuaDriver
if ($cua -and (Test-Path $cua)) {
  & $cua stop 2>$null | Out-Null
}

Remove-Item $receiptPath -Force
Write-Host "Revoked the CUA MCP capability URL and removed $receiptPath"
