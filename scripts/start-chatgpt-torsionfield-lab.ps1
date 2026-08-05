[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$RemoteDebuggingPort = 9444,
  [string]$ChromePath = "",
  [string]$ExtensionPath = "",
  [string]$ProfilePath = "",
  [string]$StartUrl = "chrome://extensions/",
  [ValidateRange(5, 120)]
  [int]$StartupTimeoutSeconds = 30,
  [switch]$Rebuild,
  [switch]$CleanProfile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$LauncherVersion = "0.2.0-lab"

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ExtensionPath) { $ExtensionPath = Join-Path $repoRoot "dist\ext" }
$runtimeRoot = Join-Path $env:LOCALAPPDATA "Torsionfield\ScriptCat-ChatGPT-Lab"
if (-not $ProfilePath) { $ProfilePath = Join-Path $runtimeRoot "chrome-profile" }
$receiptPath = Join-Path $runtimeRoot "last-launch.json"

function Resolve-ChromiumPath {
  param([string]$Requested)
  if ($Requested) {
    if (-not (Test-Path -LiteralPath $Requested -PathType Leaf)) {
      throw "Browser executable not found: $Requested"
    }
    return (Resolve-Path -LiteralPath $Requested).Path
  }

  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome SxS\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Chromium\Application\chrome.exe"
  )
  $found = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
  if (-not $found) { throw "No supported Chrome, Chrome Canary, Edge, or Chromium executable was found. Pass -ChromePath explicitly." }
  return (Resolve-Path -LiteralPath $found).Path
}

function Assert-PortAvailable {
  param([int]$Port)
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try {
    $listener.Start()
  } catch {
    throw "CDP port $Port is already occupied. Refusing to attach to or confuse an unrelated browser: $($_.Exception.Message)"
  } finally {
    try { $listener.Stop() } catch {}
  }
}

function Get-NewestSourceTime {
  $candidates = @(
    (Join-Path $repoRoot "src"),
    (Join-Path $repoRoot "public"),
    (Join-Path $repoRoot "rspack.config.ts"),
    (Join-Path $repoRoot "package.json"),
    (Join-Path $repoRoot "pnpm-lock.yaml")
  ) | Where-Object { Test-Path -LiteralPath $_ }

  $files = foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Container) {
      Get-ChildItem -LiteralPath $candidate -File -Recurse -ErrorAction SilentlyContinue
    } else {
      Get-Item -LiteralPath $candidate
    }
  }
  return ($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
}

function Build-ExtensionIfNeeded {
  $manifestPath = Join-Path $ExtensionPath "manifest.json"
  $needsBuild = $Rebuild -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)
  if (-not $needsBuild) {
    $newestSourceTime = Get-NewestSourceTime
    $manifestTime = (Get-Item -LiteralPath $manifestPath).LastWriteTimeUtc
    $needsBuild = $newestSourceTime -gt $manifestTime
  }
  if (-not $needsBuild) { return }

  Push-Location $repoRoot
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules") -PathType Container)) {
      & corepack pnpm install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
    }
    & corepack pnpm run build
    if ($LASTEXITCODE -ne 0) { throw "ScriptCat build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Build command completed but $manifestPath does not exist"
  }
}

function Read-CdpJson {
  param([string]$Path)
  return Invoke-RestMethod -Uri "http://127.0.0.1:$RemoteDebuggingPort$Path" -TimeoutSec 2
}

$ChromePath = Resolve-ChromiumPath $ChromePath
$ExtensionPath = [System.IO.Path]::GetFullPath($ExtensionPath)
$ProfilePath = [System.IO.Path]::GetFullPath($ProfilePath)
Assert-PortAvailable $RemoteDebuggingPort
Build-ExtensionIfNeeded

$manifestPath = Join-Path $ExtensionPath "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "ScriptCat manifest not found: $manifestPath" }

if ($CleanProfile -and (Test-Path -LiteralPath $ProfilePath)) {
  $lockFiles = @("SingletonLock", "SingletonCookie", "SingletonSocket") | ForEach-Object { Join-Path $ProfilePath $_ }
  if ($lockFiles | Where-Object { Test-Path -LiteralPath $_ }) {
    throw "Profile appears active or uncleanly closed. Refusing to delete it: $ProfilePath"
  }
  Remove-Item -LiteralPath $ProfilePath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $ProfilePath, $runtimeRoot | Out-Null

$arguments = @(
  "--user-data-dir=$ProfilePath",
  "--disable-extensions-except=$ExtensionPath",
  "--load-extension=$ExtensionPath",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=$RemoteDebuggingPort",
  "--no-first-run",
  "--no-default-browser-check",
  $StartUrl
)

$process = $null
try {
  $process = Start-Process -FilePath $ChromePath -ArgumentList $arguments -PassThru
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $version = $null
  while ((Get-Date) -lt $deadline -and -not $version) {
    if ($process.HasExited) { throw "Browser exited before CDP became available with code $($process.ExitCode)" }
    try { $version = Read-CdpJson "/json/version" } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $version) { throw "Browser started, but CDP did not become available on 127.0.0.1:$RemoteDebuggingPort" }

  $worker = $null
  while ((Get-Date) -lt $deadline -and -not $worker) {
    try {
      $targets = @(Read-CdpJson "/json/list")
      $worker = $targets | Where-Object {
        $_.type -eq "service_worker" -and $_.url -like "chrome-extension://*/service_worker.js"
      } | Select-Object -First 1
    } catch {}
    if (-not $worker) { Start-Sleep -Milliseconds 300 }
  }
  if (-not $worker) { throw "CDP is available, but ScriptCat's service worker did not appear before the timeout" }

  $extensionId = ([regex]::Match($worker.url, "chrome-extension://([^/]+)/")).Groups[1].Value
  if (-not $extensionId) { throw "Could not derive the ScriptCat extension ID from $($worker.url)" }

  $gitCommit = $null
  try {
    $gitCommit = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -ne 0) { $gitCommit = $null }
  } catch { $gitCommit = $null }

  $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $receipt = [ordered]@{
    ok = $true
    launcherVersion = $LauncherVersion
    processId = $process.Id
    browserPath = $ChromePath
    browserVersion = $version.Browser
    extensionId = $extensionId
    extensionPath = $ExtensionPath
    manifestSha256 = $manifestHash
    repositoryCommit = $gitCommit
    profilePath = $ProfilePath
    remoteDebuggingAddress = "127.0.0.1"
    remoteDebuggingPort = $RemoteDebuggingPort
    serviceWorker = $worker.url
    commandArguments = $arguments
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $receipt | ConvertTo-Json -Depth 4
} catch {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  throw
}
