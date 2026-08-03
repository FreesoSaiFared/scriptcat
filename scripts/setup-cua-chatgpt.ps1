[CmdletBinding()]
param(
  [int]$Port = 8765,
  [int]$SecretBytes = 32,
  [bool]$Unrestricted = $true,
  [switch]$DisableTelemetry
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$runtimeRoot = Join-Path $env:LOCALAPPDATA "Torsionfield\cua-mcp"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null

function Resolve-Executable([string]$Name, [string[]]$Candidates) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

$cua = Resolve-Executable "cua-driver.exe" @(
  (Join-Path $HOME ".local\bin\cua-driver.exe"),
  (Join-Path $HOME ".cua-driver\current\cua-driver.exe"),
  (Join-Path $env:LOCALAPPDATA "cua-driver\current\cua-driver.exe")
)
if (-not $cua) {
  Write-Host "Installing the official CUA Driver..."
  Invoke-Expression (Invoke-RestMethod "https://cua.ai/driver/install.ps1")
  $cua = Resolve-Executable "cua-driver.exe" @(
    (Join-Path $HOME ".local\bin\cua-driver.exe"),
    (Join-Path $HOME ".cua-driver\current\cua-driver.exe"),
    (Join-Path $env:LOCALAPPDATA "cua-driver\current\cua-driver.exe")
  )
}
if (-not $cua) { throw "CUA Driver was installed but cua-driver.exe could not be resolved." }
if ($DisableTelemetry) { & $cua telemetry disable | Out-Host }

# The URL is the bearer capability requested by the user. The daemon therefore
# runs without a second approval layer when -Unrestricted remains true.
& $cua stop 2>$null | Out-Null
$daemonArgs = @("serve")
if ($Unrestricted) { $daemonArgs += "--dangerously-bypass-approvals" }
$daemonStdout = Join-Path $runtimeRoot "cua-daemon.stdout.log"
$daemonStderr = Join-Path $runtimeRoot "cua-daemon.stderr.log"
$daemon = Start-Process -FilePath $cua -ArgumentList $daemonArgs -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $daemonStdout -RedirectStandardError $daemonStderr

$daemonReady = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  & $cua status *> $null
  if ($LASTEXITCODE -eq 0) { $daemonReady = $true; break }
}
if (-not $daemonReady) { throw "CUA daemon did not become ready. See $daemonStderr" }

$doctor = (& $cua doctor --json 2>&1 | Out-String).Trim()
$windows = (& $cua call list_windows 2>&1 | Out-String).Trim()
if (-not $windows -or $windows -eq "[]") {
  throw "CUA Driver is running but cannot see the interactive Windows desktop. Run this script from the logged-in desktop session."
}

$cloudflared = Resolve-Executable "cloudflared.exe" @(
  (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe"),
  (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe")
)
if (-not $cloudflared) {
  $winget = Resolve-Executable "winget.exe" @()
  if (-not $winget) { throw "cloudflared is absent and winget.exe is unavailable." }
  & $winget install --id Cloudflare.cloudflared --exact --silent `
    --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "cloudflared installation failed with exit code $LASTEXITCODE" }
  $cloudflared = Resolve-Executable "cloudflared.exe" @(
    (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe")
  )
}
if (-not $cloudflared) { throw "cloudflared.exe could not be resolved after installation." }

$npx = Resolve-Executable "npx.cmd" @((Join-Path $env:ProgramFiles "nodejs\npx.cmd"))
if (-not $npx) { throw "npx.cmd is required to run the pinned MCP transport bridge." }

$bytes = New-Object byte[] $SecretBytes
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secret = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$mcpPath = "/$secret/mcp"
$gatewayLog = Join-Path $runtimeRoot "mcp-gateway.log"
$gatewayCmd = Join-Path $runtimeRoot "run-mcp-gateway.cmd"
$cuaDir = Split-Path -Parent $cua
@"
@echo off
set "PATH=$cuaDir;%PATH%"
"$npx" -y supergateway@3.4.3 --stdio "cua-driver.exe mcp" --outputTransport streamableHttp --stateful --sessionTimeout 86400000 --port $Port --streamableHttpPath "$mcpPath" --logLevel info >> "$gatewayLog" 2>&1
"@ | Set-Content -Encoding ASCII $gatewayCmd

$gateway = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/c", $gatewayCmd) -WindowStyle Hidden -PassThru
$gatewayReady = $false
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $client = [Net.Sockets.TcpClient]::new()
    $client.Connect("127.0.0.1", $Port)
    $client.Dispose()
    $gatewayReady = $true
    break
  } catch {}
}
if (-not $gatewayReady) { throw "MCP gateway did not bind to 127.0.0.1:$Port. See $gatewayLog" }

$tunnelLog = Join-Path $runtimeRoot "cloudflared.log"
if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }
$tunnel = Start-Process -FilePath $cloudflared -ArgumentList @(
  "tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate",
  "--loglevel", "info", "--logfile", $tunnelLog
) -WindowStyle Hidden -PassThru

$publicBase = $null
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $tunnelLog) {
    $match = [regex]::Match((Get-Content $tunnelLog -Raw), "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($match.Success) { $publicBase = $match.Value; break }
  }
}
if (-not $publicBase) { throw "Cloudflare Quick Tunnel did not publish a URL. See $tunnelLog" }
$endpoint = "$publicBase$mcpPath"

$probeBody = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"torsionfield-probe","version":"0.1"}}}'
$probeHeaders = Join-Path $runtimeRoot "probe.headers.txt"
$probeBodyFile = Join-Path $runtimeRoot "probe.body.txt"
& curl.exe --silent --show-error --max-time 20 -D $probeHeaders -o $probeBodyFile `
  -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" `
  --data $probeBody $endpoint
$probeExitCode = $LASTEXITCODE

$receipt = [ordered]@{
  ok = ($probeExitCode -eq 0)
  endpoint = $endpoint
  authentication = "url-capability"
  secretBits = ($SecretBytes * 8)
  localEndpoint = "http://127.0.0.1:$Port$mcpPath"
  cuaDriver = $cua
  cuaDaemonPid = $daemon.Id
  gatewayPid = $gateway.Id
  tunnelPid = $tunnel.Id
  doctor = $doctor
  windowsProbe = $windows
  probeExitCode = $probeExitCode
  runtimeRoot = $runtimeRoot
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
}
$receiptPath = Join-Path $runtimeRoot "connection.json"
$receipt | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $receiptPath

Write-Host ""
Write-Host "CUA MCP endpoint for ChatGPT:"
Write-Host $endpoint
Write-Host ""
Write-Host "Receipt: $receiptPath"
Write-Host "Treat the complete URL as a bearer secret. Run scripts/stop-cua-chatgpt.ps1 to revoke it."
$receipt | ConvertTo-Json -Depth 6
