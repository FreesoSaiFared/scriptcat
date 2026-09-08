[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA "sctl\data"),
  [string]$SctlExe = (Join-Path $env:LOCALAPPDATA "sctl\bin\sctl.exe"),
  [int]$TimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$env:SCTL_DATA_DIR = $DataDir

function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $SctlExe)) { throw "missing sctl executable: $SctlExe" }

$version = (& $SctlExe version 2>&1 | Out-String).Trim()
Assert-Exit "sctl version"
$status = (& $SctlExe status 2>&1 | Out-String).Trim()
Assert-Exit "sctl status"
$inventoryRaw = (& $SctlExe get -o json 2>&1 | Out-String).Trim()
Assert-Exit "sctl get -o json"
try { $inventory = $inventoryRaw | ConvertFrom-Json } catch { throw "sctl inventory was not valid JSON: $inventoryRaw" }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $SctlExe
$psi.Arguments = 'mcp --name torsionfield-acceptance'
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables['SCTL_DATA_DIR'] = $DataDir
$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
if (-not $proc.Start()) { throw "failed to start sctl mcp" }

$initialize = @{ jsonrpc='2.0'; id=1; method='initialize'; params=@{ protocolVersion='2025-06-18'; capabilities=@{}; clientInfo=@{ name='torsionfield-acceptance'; version='1' } } } | ConvertTo-Json -Compress -Depth 8
$initialized = @{ jsonrpc='2.0'; method='notifications/initialized'; params=@{} } | ConvertTo-Json -Compress -Depth 8
$toolsList = @{ jsonrpc='2.0'; id=2; method='tools/list'; params=@{} } | ConvertTo-Json -Compress -Depth 8

$proc.StandardInput.WriteLine($initialize)
$proc.StandardInput.Flush()

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$initResponse = $null
while ([DateTime]::UtcNow -lt $deadline -and -not $initResponse) {
  $task = $proc.StandardOutput.ReadLineAsync()
  if (-not $task.Wait(500)) { continue }
  $line = $task.Result
  if ($null -eq $line) { break }
  try { $msg = $line | ConvertFrom-Json } catch { continue }
  if ($msg.id -eq 1) { $initResponse = $msg }
}
if (-not $initResponse) {
  $stderr = $proc.StandardError.ReadToEnd()
  try { $proc.Kill() } catch {}
  throw "MCP initialize timed out. stderr=$stderr"
}
if ($initResponse.error) {
  try { $proc.Kill() } catch {}
  throw "MCP initialize failed: $($initResponse.error | ConvertTo-Json -Compress -Depth 8)"
}

$proc.StandardInput.WriteLine($initialized)
$proc.StandardInput.WriteLine($toolsList)
$proc.StandardInput.Flush()

$toolsResponse = $null
while ([DateTime]::UtcNow -lt $deadline -and -not $toolsResponse) {
  $task = $proc.StandardOutput.ReadLineAsync()
  if (-not $task.Wait(500)) { continue }
  $line = $task.Result
  if ($null -eq $line) { break }
  try { $msg = $line | ConvertFrom-Json } catch { continue }
  if ($msg.id -eq 2) { $toolsResponse = $msg }
}
try { $proc.Kill() } catch {}
if (-not $toolsResponse) { throw "MCP tools/list timed out" }
if ($toolsResponse.error) { throw "MCP tools/list failed: $($toolsResponse.error | ConvertTo-Json -Compress -Depth 8)" }

$expected = @(
  'scripts_list',
  'scripts_metadata_get',
  'scripts_source_get',
  'scripts_source_grep',
  'scripts_install_request',
  'scripts_toggle_request',
  'scripts_delete_request',
  'scripts_edit_request'
)
$actual = @($toolsResponse.result.tools | ForEach-Object { $_.name })
$missing = @($expected | Where-Object { $_ -notin $actual })
if ($missing.Count -gt 0) { throw "MCP tool surface incomplete; missing: $($missing -join ', ')" }

$result = [ordered]@{
  ok = $true
  sctl = $version
  status = $status
  dataDir = $DataDir
  inventoryCount = @($inventory).Count
  expectedTools = $expected
  actualTools = $actual
  verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$result | ConvertTo-Json -Depth 8
